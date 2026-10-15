import { access } from 'node:fs/promises';
import path from 'node:path';

import {
  RunManifestSchema,
  SuiteManifestSchema,
  type BenchmarkConfig,
  type BenchmarkJob,
  type InfrastructureFailure,
  type RunManifest,
  type SuiteManifest,
} from '../domain/contract/index.js';
import { sha256, stableJson } from '../domain/hash.js';
import type { BenchmarkPlan } from '../domain/suite/plan.js';

import { salvageAttemptVerdict } from './attempt-salvage.js';
import { readJsonFile, writeJsonAtomic } from './io.js';

const TERMINAL = new Set<RunManifest['status']>([
  'completed',
  'invalid_infrastructure',
]);

const TRANSITIONS: Readonly<
  Record<RunManifest['status'], readonly RunManifest['status'][]>
> = {
  planned: ['preparing', 'invalid_infrastructure'],
  preparing: ['running', 'invalid_infrastructure'],
  running: ['capturing', 'invalid_infrastructure'],
  capturing: ['verifying', 'invalid_infrastructure'],
  verifying: ['completed', 'invalid_infrastructure'],
  completed: [],
  invalid_infrastructure: [],
};

export interface AttemptSelection {
  readonly run?: RunManifest;
  readonly skipReason?: 'completed' | 'retry_exhausted';
}

export async function openSuiteManifest(options: {
  readonly runRoot: string;
  readonly config: BenchmarkConfig;
  readonly plan: BenchmarkPlan;
}): Promise<{ readonly path: string; manifest: SuiteManifest }> {
  const runRoot = path.resolve(options.runRoot);
  const manifestPath = path.join(runRoot, 'suite-manifest.json');
  if (await exists(manifestPath)) {
    const manifest = await readJsonFile(manifestPath, SuiteManifestSchema);
    // if (manifest.configHash !== options.plan.configHash) {
    //   throw new Error(
    //     `Run root config hash mismatch: ${manifest.configHash} versus ${options.plan.configHash}.`,
    //   );
    // }
    // if (manifest.planHash !== options.plan.planHash) {
    //   throw new Error(
    //     `Run root plan hash mismatch: ${manifest.planHash} versus ${options.plan.planHash}.`,
    //   );
    // }
    // if (stableJson(manifest.jobs) !== stableJson(options.plan.jobs)) {
    //   throw new Error(`Run root job matrix does not match the current plan.`);
    // }
    return { path: manifestPath, manifest };
  }
  const now = new Date().toISOString();
  const manifest = SuiteManifestSchema.parse({
    schema: 'ello.benchmark.suite-manifest.v3',
    suite: options.config.suite,
    report: options.config.report,
    configHash: options.plan.configHash,
    planHash: options.plan.planHash,
    agents: options.config.agents.filter((agent) =>
      options.plan.selection.agentIds.includes(agent.id),
    ),
    selection: options.plan.selection,
    runRoot,
    createdAt: now,
    updatedAt: now,
    jobs: options.plan.jobs,
    attempts: Object.fromEntries(
      options.plan.jobs.map((job) => [job.jobId, []]),
    ),
  });
  await writeJsonAtomic(manifestPath, manifest);
  return { path: manifestPath, manifest };
}

export async function selectAttempt(options: {
  readonly suitePath: string;
  readonly suite: SuiteManifest;
  readonly job: BenchmarkJob;
  readonly maxInfrastructureRetries: number;
}): Promise<AttemptSelection> {
  const attemptPaths = options.suite.attempts[options.job.jobId] ?? [];
  let previous: RunManifest | undefined;
  if (attemptPaths.length > 0) {
    const previousPath = attemptPaths.at(-1);
    if (previousPath === undefined)
      throw new Error('Missing previous attempt path.');
    previous = await readJsonFile(previousPath, RunManifestSchema);
    if (previous.job.jobId !== options.job.jobId) {
      throw new Error(`Attempt job mismatch: ${previousPath}`);
    }
    if (!TERMINAL.has(previous.status)) {
      // 先尝试收割：判决可能已经算完并落盘，只是没来得及记账。丢掉它等于把
      // 已经跑完的 agent 和已经产出的 reward 一起作废，还白烧一次重试配额。
      previous = await completeInterruptedRun(previousPath, previous);
    }
    if (previous.status === 'completed') return { skipReason: 'completed' };
    // 收割可能把**更早**的 attempt 补记成 completed（它被打断时判决已产出，而
    // 后续 attempt 是在不知情的情况下开出来的）。只看最后一个会漏掉这种情况，
    // 于是这个 job 又被重跑一遍——已经有判决的 job 一律不再跑。
    const completedEarlier = await findCompletedAttempt(attemptPaths);
    if (completedEarlier !== undefined) return { skipReason: 'completed' };
    if (previous.attempt > options.maxInfrastructureRetries) {
      return { skipReason: 'retry_exhausted' };
    }
  }
  const attempt = (previous?.attempt ?? 0) + 1;
  const attemptId = sha256(
    stableJson({
      configHash: options.suite.configHash,
      jobId: options.job.jobId,
      attempt,
      runRoot: options.suite.runRoot,
    }),
  ).slice(0, 24);
  const attemptRoot = path.join(
    options.suite.runRoot,
    'runs',
    options.job.taskId,
    options.job.agentId,
    `r${options.job.replicate}`,
    `attempt-${attempt}-${attemptId}`,
  );
  const run = RunManifestSchema.parse({
    schema: 'ello.benchmark.run.v2',
    attemptId,
    attempt,
    ...(previous === undefined
      ? {}
      : {
          retryOf: previous.attemptId,
          retryReason: previous.failure,
        }),
    job: options.job,
    configHash: options.suite.configHash,
    status: 'planned',
    phase: 'planned',
    attemptRoot,
    workspace: path.join(attemptRoot, 'workspace'),
    agentStateRoot: path.join(attemptRoot, 'agent-state'),
  });
  const runPath = path.join(attemptRoot, 'run.json');
  await writeJsonAtomic(runPath, run);
  const updatedSuite = SuiteManifestSchema.parse({
    ...options.suite,
    updatedAt: new Date().toISOString(),
    attempts: {
      ...options.suite.attempts,
      [options.job.jobId]: [...attemptPaths, runPath],
    },
  });
  await writeJsonAtomic(options.suitePath, updatedSuite);
  Object.assign(options.suite, updatedSuite);
  return { run };
}

export async function transitionRun(
  manifest: RunManifest,
  nextStatus: RunManifest['status'],
  fields: Partial<
    Omit<RunManifest, 'schema' | 'attemptId' | 'job' | 'configHash'>
  >,
): Promise<RunManifest> {
  if (!TRANSITIONS[manifest.status].includes(nextStatus)) {
    throw new Error(
      `Invalid run transition ${manifest.status} -> ${nextStatus}.`,
    );
  }
  const next = RunManifestSchema.parse({
    ...manifest,
    ...fields,
    status: nextStatus,
  });
  await writeJsonAtomic(path.join(manifest.attemptRoot, 'run.json'), next);
  return next;
}

export async function updateRun(
  manifest: RunManifest,
  fields: Partial<
    Omit<RunManifest, 'schema' | 'attemptId' | 'job' | 'configHash'>
  >,
): Promise<RunManifest> {
  if (TERMINAL.has(manifest.status)) {
    throw new Error(`Terminal run cannot be updated: ${manifest.attemptId}`);
  }
  const next = RunManifestSchema.parse({ ...manifest, ...fields });
  await writeJsonAtomic(path.join(manifest.attemptRoot, 'run.json'), next);
  return next;
}

export async function invalidateRun(
  manifest: RunManifest,
  failure: InfrastructureFailure,
): Promise<RunManifest> {
  if (TERMINAL.has(manifest.status)) {
    throw new Error(
      `Terminal run cannot be invalidated: ${manifest.attemptId}`,
    );
  }
  return transitionRun(manifest, 'invalid_infrastructure', {
    phase: failure.phase,
    completedAt: new Date().toISOString(),
    failure,
  });
}

async function findCompletedAttempt(
  attemptPaths: readonly string[],
): Promise<RunManifest | undefined> {
  for (const attemptPath of attemptPaths) {
    const manifest = await readJsonFile(attemptPath, RunManifestSchema);
    if (manifest.status === 'completed') return manifest;
  }
  return undefined;
}

async function completeInterruptedRun(
  runPath: string,
  manifest: RunManifest,
): Promise<RunManifest> {
  const salvaged = await salvageAttemptVerdict(manifest);
  if (salvaged !== undefined) {
    await writeJsonAtomic(runPath, salvaged.manifest);
    return salvaged.manifest;
  }
  return invalidateInterruptedRun(runPath, manifest);
}

async function invalidateInterruptedRun(
  runPath: string,
  manifest: RunManifest,
): Promise<RunManifest> {
  const failure: InfrastructureFailure = {
    kind: 'runner',
    phase: 'resume-interrupted-run',
    message: `Runner stopped while attempt was in state ${manifest.status}.`,
  };
  const invalid = RunManifestSchema.parse({
    ...manifest,
    status: 'invalid_infrastructure',
    phase: failure.phase,
    completedAt: new Date().toISOString(),
    failure,
  });
  await writeJsonAtomic(runPath, invalid);
  return invalid;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}
