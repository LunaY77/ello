import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  ResolvedTaskSchema,
  type ResolvedTask,
  type SweBenchProTaskDeclaration,
} from './contracts.js';
import { sha256, stableJson } from './hash.js';

const DATASET_PATH = path.join('helper_code', 'sweap_eval_full_v2.jsonl');
const DOCKERHUB_REPOSITORY = 'jefzda/sweap-images';
const AGENT_TIMEOUT_MS = 60 * 60_000;
const VERIFIER_TIMEOUT_MS = 60 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
export const SWE_BENCH_PRO_DATASET_TASK_COUNT = 731;

const SweBenchProRowSchema = z
  .object({
    image_name: z.string().min(1),
    instance_id: z.string().regex(/^instance_[A-Za-z0-9_.-]+$/u),
    hints_text: z.string(),
    problem_statement: z.string().min(1),
    patch: z.string().min(1),
    test_patch: z.string(),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    base_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    base_dockerfile: z.string().min(1),
    instance_dockerfile: z.string().min(1),
    before_repo_set_cmd: z.string().min(1),
    selected_test_files_to_run: z.string().min(1),
    FAIL_TO_PASS: z.array(z.string()),
    PASS_TO_PASS: z.string().min(1),
    is_remote_image: z.boolean(),
    created_at: z.string().min(1),
    version: z.string().min(1),
    repo_name: z.string().min(1),
    run_script: z.string().url(),
    parsing_script: z.string().url(),
  })
  .strict();

type SweBenchProRow = z.infer<typeof SweBenchProRowSchema>;

export interface SweBenchProTestSpec {
  readonly selectedTests: readonly string[];
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
}

export interface LoadedSweBenchProTask {
  readonly task: Extract<ResolvedTask, { benchmark: 'swe-bench-pro' }>;
  readonly instruction: string;
  readonly runScriptPath: string;
  readonly parserPath: string;
  readonly workspaceSetupCommands: readonly (readonly string[])[];
  readonly testSpec: SweBenchProTestSpec;
}

export async function loadSweBenchProRows(
  corpusRoot: string,
  expectedTaskCount: number,
): Promise<ReadonlyMap<string, SweBenchProRow>> {
  const datasetPath = path.join(path.resolve(corpusRoot), DATASET_PATH);
  const source = await readFile(datasetPath, 'utf8');
  const rows = new Map<string, SweBenchProRow>();
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line === '') continue;
    const row = SweBenchProRowSchema.parse(JSON.parse(line) as unknown);
    if (rows.has(row.instance_id)) {
      throw new Error(
        `Duplicate SWE-bench Pro instance ${row.instance_id} at JSONL line ${index + 1}.`,
      );
    }
    rows.set(row.instance_id, row);
  }
  if (rows.size !== expectedTaskCount) {
    throw new Error(
      `SWE-bench Pro dataset task count mismatch: expected ${expectedTaskCount}, received ${rows.size}.`,
    );
  }
  return rows;
}

export async function loadSweBenchProTask(
  corpusRoot: string,
  declaration: SweBenchProTaskDeclaration,
  rows: ReadonlyMap<string, SweBenchProRow>,
): Promise<LoadedSweBenchProTask> {
  const row = rows.get(declaration.instanceId);
  if (row === undefined) {
    throw new Error(
      `Missing SWE-bench Pro instance ${declaration.instanceId}.`,
    );
  }
  const instruction = decodeProblemStatement(row.problem_statement);
  const runScriptPath = path.join(
    path.resolve(corpusRoot),
    'run_scripts',
    row.instance_id,
    'run_script.sh',
  );
  const parserPath = path.join(
    path.resolve(corpusRoot),
    'run_scripts',
    row.instance_id,
    'parser.py',
  );
  const [runScript, parser] = await Promise.all([
    readFile(runScriptPath, 'utf8'),
    readFile(parserPath, 'utf8'),
  ]);
  const workspaceSetupCommands = parseWorkspaceSetup(
    row.before_repo_set_cmd,
    row.base_commit,
  );
  const testSpec = {
    selectedTests: parseStringList(
      row.selected_test_files_to_run,
      'selected_test_files_to_run',
      row.instance_id,
    ),
    failToPass: parseStringList(
      row.FAIL_TO_PASS,
      'FAIL_TO_PASS',
      row.instance_id,
    ),
    passToPass: parseStringList(
      row.PASS_TO_PASS,
      'PASS_TO_PASS',
      row.instance_id,
    ),
  } satisfies SweBenchProTestSpec;
  if (testSpec.selectedTests.length === 0) {
    throw new Error(
      `SWE-bench Pro selected tests are empty: ${row.instance_id}.`,
    );
  }
  if (testSpec.failToPass.length === 0) {
    throw new Error(`SWE-bench Pro FAIL_TO_PASS is empty: ${row.instance_id}.`);
  }
  assertUnique(testSpec.failToPass, 'FAIL_TO_PASS', row.instance_id);
  assertUnique(testSpec.passToPass, 'PASS_TO_PASS', row.instance_id);
  const overlap = testSpec.failToPass.filter((name) =>
    testSpec.passToPass.includes(name),
  );
  if (overlap.length > 0) {
    throw new Error(
      `SWE-bench Pro expected-test sets overlap for ${row.instance_id}: ${overlap.join(', ')}.`,
    );
  }
  const title = extractTitle(instruction, row.instance_id);
  const task = ResolvedTaskSchema.parse({
    schema: 'ello.benchmark.resolved-task.v2',
    benchmark: 'swe-bench-pro',
    taskId: declaration.taskId,
    extId: row.instance_id,
    displayTitle: title,
    displayDescription: instruction,
    originalTitle: title,
    category: 'swe-bench-pro',
    language: declaration.language,
    repositoryUrl: `https://github.com/${row.repo}.git`,
    baseCommitHash: row.base_commit,
    agentTimeoutMs: AGENT_TIMEOUT_MS,
    verifierTimeoutMs: VERIFIER_TIMEOUT_MS,
    environment: {
      image: dockerImage(row.instance_id, row.repo),
      allowInternet: false,
      buildTimeoutMs: BUILD_TIMEOUT_MS,
      cpus: 4,
      memoryMb: 30 * 1024,
      storageMb: 30 * 1024,
    },
    instructionSha256: sha256(instruction),
    workspaceSetupSha256: sha256(row.before_repo_set_cmd),
    runScriptSha256: sha256(runScript),
    parserSha256: sha256(parser),
    testSpecSha256: sha256(stableJson(testSpec)),
  });
  if (task.benchmark !== 'swe-bench-pro') {
    throw new Error(`Resolved unexpected task benchmark: ${task.benchmark}.`);
  }
  return {
    task,
    instruction,
    runScriptPath,
    parserPath,
    workspaceSetupCommands,
    testSpec,
  };
}

function decodeProblemStatement(value: string): string {
  const requirementsMarker = '\n\nRequirements:\n';
  const interfacesMarker = '\n\nNew interfaces introduced:\n';
  const requirementsIndex = value.indexOf(requirementsMarker);
  const interfacesIndex = value.indexOf(interfacesMarker);
  if (
    requirementsIndex <= 0 ||
    interfacesIndex <= requirementsIndex + requirementsMarker.length
  ) {
    throw new Error('Invalid SWE-bench Pro problem statement sections.');
  }
  const problem = decodeProblemBlock(value.slice(0, requirementsIndex));
  const requirements = decodeProblemBlock(
    value.slice(requirementsIndex + requirementsMarker.length, interfacesIndex),
  );
  const interfaces = decodeProblemBlock(
    value.slice(interfacesIndex + interfacesMarker.length),
  );
  return `${problem}\n\nRequirements:\n${requirements}\n\nNew interfaces introduced:\n${interfaces}`;
}

function decodeProblemBlock(value: string): string {
  const trimmed = value.trim();
  const decoded: unknown = trimmed.startsWith('"')
    ? JSON.parse(trimmed)
    : trimmed;
  if (typeof decoded !== 'string' || decoded.trim() === '') {
    throw new Error('SWE-bench Pro problem statement block is empty.');
  }
  return decoded.trim();
}

function parseStringList(
  value: string | string[],
  field: string,
  instanceId: string,
): string[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const result = z.array(z.string().min(1)).parse(parsed);
  if (result.some((entry) => entry.trim() !== entry)) {
    throw new Error(
      `SWE-bench Pro ${field} contains surrounding whitespace: ${instanceId}.`,
    );
  }
  return result;
}

function parseWorkspaceSetup(
  source: string,
  baseCommit: string,
): readonly (readonly string[])[] {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length !== 4) {
    throw new Error(
      `SWE-bench Pro workspace setup must contain four commands, received ${lines.length}.`,
    );
  }
  const [resetLine, cleanLine, checkoutLine, testsLine] = lines;
  if (
    resetLine === undefined ||
    cleanLine === undefined ||
    checkoutLine === undefined ||
    testsLine === undefined
  ) {
    throw new Error('Incomplete SWE-bench Pro workspace setup protocol.');
  }
  const reset = /^git reset --hard ([0-9a-f]{40})$/u.exec(resetLine);
  const clean = /^git clean -fd$/u.exec(cleanLine);
  const checkout = /^git checkout ([0-9a-f]{40})$/u.exec(checkoutLine);
  const tests =
    /^git checkout ([0-9a-f]{40}) -- ([A-Za-z0-9_./@+-]+(?: [A-Za-z0-9_./@+-]+)*)$/u.exec(
      testsLine,
    );
  if (
    reset === null ||
    reset[1] !== baseCommit ||
    clean === null ||
    checkout === null ||
    checkout[1] !== baseCommit ||
    tests === null ||
    tests[1] === undefined ||
    tests[2] === undefined
  ) {
    throw new Error('Invalid SWE-bench Pro workspace setup protocol.');
  }
  return [
    ['reset', '--hard', baseCommit],
    ['clean', '-fd'],
    ['checkout', baseCommit],
    ['checkout', tests[1], '--', ...tests[2].split(' ')],
  ];
}

function dockerImage(instanceId: string, repository: string): string {
  const [repoBase, rawRepoName, extra] = repository.toLowerCase().split('/');
  if (
    repoBase === undefined ||
    rawRepoName === undefined ||
    extra !== undefined
  ) {
    throw new Error(`Invalid SWE-bench Pro repository: ${repository}.`);
  }
  let repoName = rawRepoName;
  let hash = instanceId.replace(/^instance_/u, '');
  if (
    instanceId ===
    'instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan'
  ) {
    repoName = 'element-web';
  } else if (repository.toLowerCase() === 'element-hq/element-web') {
    repoName = 'element';
    hash = hash.replace(/-vnan$/u, '');
  } else {
    hash = hash.replace(/-vnan$/u, '');
  }
  const tag = `${repoBase}.${repoName}-${hash}`.slice(0, 128);
  return `${DOCKERHUB_REPOSITORY}:${tag}`;
}

function extractTitle(instruction: string, instanceId: string): string {
  const lines = instruction
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const line of lines) {
    const candidate = line
      .replace(/^#+\s*/u, '')
      .replace(/^\*\*/u, '')
      .replace(/\*\*$/u, '')
      .replace(/^Title:\s*/iu, '')
      .trim();
    if (candidate !== '' && candidate.toLowerCase() !== 'title') {
      return candidate;
    }
  }
  throw new Error(`SWE-bench Pro title is empty: ${instanceId}.`);
}

function assertUnique(
  values: readonly string[],
  field: string,
  instanceId: string,
): void {
  if (new Set(values).size !== values.length) {
    throw new Error(
      `SWE-bench Pro ${field} contains duplicates: ${instanceId}.`,
    );
  }
}
