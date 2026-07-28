import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CONTAINER_HOME } from './container-user.js';
import {
  DeepSweTaskDeclarationSchema,
  SweBenchProTaskDeclarationSchema,
  type BenchmarkSuiteId,
  type BenchmarkSuiteMetadata,
  type ResolvedTask,
  type SweBenchProTaskDeclaration,
  type TaskDeclaration,
} from './contracts.js';
import { loadDeepSweTask, type LoadedDeepSweTask } from './deep-swe-corpus.js';
import { writeJsonAtomic } from './io.js';
import { runChecked } from './process.js';
import {
  loadSweBenchProRows,
  loadSweBenchProTask,
  SWE_BENCH_PRO_DATASET_TASK_COUNT,
  type SweBenchProTestSpec,
} from './swe-bench-pro-corpus.js';
import {
  SWE_BENCH_PRO_SOURCE_REPOSITORY,
  SWE_BENCH_PRO_SOURCE_REVISION,
  SWE_BENCH_PRO_TASK_SET_HASH,
  SWE_BENCH_PRO_TASKS,
} from './swe-bench-pro-tasks.js';
import { SWE_BENCH_PRO_VERIFIER } from './swe-bench-pro-verifier.js';
import {
  DEEP_SWE_SOURCE_REPOSITORY,
  DEEP_SWE_SOURCE_REVISION,
  DEEP_SWE_TASK_SET_HASH,
  DEEP_SWE_TASKS,
} from './tasks.js';
import {
  auditVerifierPatchOverlap,
  patchChangedFiles,
} from './verifier-audit.js';

export interface SweBenchProResolvedTaskFiles {
  readonly benchmark: 'swe-bench-pro';
  readonly task: Extract<ResolvedTask, { benchmark: 'swe-bench-pro' }>;
  readonly instruction: string;
  readonly runScriptPath: string;
  readonly parserPath: string;
  readonly workspaceSetupCommands: readonly (readonly string[])[];
  readonly workspacePatch: string;
  readonly testSpec: SweBenchProTestSpec;
}

export type ResolvedTaskFiles =
  | LoadedDeepSweTask
  | SweBenchProResolvedTaskFiles;

export interface SuiteContainerProcess {
  readonly entrypoint?: string;
  readonly command: readonly string[];
}

export interface BenchmarkSuiteAdapter {
  readonly metadata: BenchmarkSuiteMetadata;
  readonly taskBenchmark: ResolvedTask['benchmark'];
  readonly tasks: readonly TaskDeclaration[];
  readonly corpusCacheDirectory: string;
  readonly shellMode: 'login' | 'preserve-environment';
  readonly agentContainer: SuiteContainerProcess;
  readonly verifierContainer: SuiteContainerProcess;
  loadTask(
    corpusRoot: string,
    declaration: TaskDeclaration,
  ): Promise<ResolvedTaskFiles>;
  loadTasks(
    corpusRoot: string,
  ): Promise<ReadonlyMap<string, ResolvedTaskFiles>>;
  prepareWorkspace(
    workspace: string,
    taskFiles: ResolvedTaskFiles,
    source: 'image' | 'repository',
  ): Promise<void>;
  stageVerifier(
    taskFiles: ResolvedTaskFiles,
    testsDirectory: string,
  ): Promise<void>;
  auditVerifier(options: {
    readonly workspace: string;
    readonly testsDirectory: string;
    readonly modelChangedFiles: readonly string[];
  }): Promise<{
    readonly hiddenPatchChangedFiles: readonly string[];
    readonly patchConflictFiles: readonly string[];
  }>;
}

const DEEP_SWE: BenchmarkSuiteAdapter = {
  metadata: {
    id: 'deep-swe-v1.1',
    benchmarkId: 'ello.benchmark.deepswe.v1.1',
    displayName: 'DeepSWE v1.1 curated',
    source: {
      repository: DEEP_SWE_SOURCE_REPOSITORY,
      revision: DEEP_SWE_SOURCE_REVISION,
    },
    taskSetHash: DEEP_SWE_TASK_SET_HASH,
    selectedTaskCount: DEEP_SWE_TASKS.length,
    upstreamTaskCount: 113,
    selectionKind: 'curated',
    scoreMetric: 'binary-reward',
  },
  taskBenchmark: 'deep-swe',
  tasks: DEEP_SWE_TASKS,
  corpusCacheDirectory: 'deep-swe',
  shellMode: 'login',
  agentContainer: { command: ['sleep', 'infinity'] },
  verifierContainer: {
    command: [
      '/bin/bash',
      '-lc',
      `mkdir -p ${CONTAINER_HOME} && exec /bin/bash /tests/test.sh`,
    ],
  },
  async loadTask(corpusRoot, declaration) {
    return loadDeepSweTask(
      corpusRoot,
      DeepSweTaskDeclarationSchema.parse(declaration),
    );
  },
  async loadTasks(corpusRoot) {
    return new Map(
      await Promise.all(
        DEEP_SWE_TASKS.map(
          async (declaration) =>
            [
              declaration.taskId,
              await loadDeepSweTask(corpusRoot, declaration),
            ] as const,
        ),
      ),
    );
  },
  prepareWorkspace: () => Promise.resolve(),
  async stageVerifier(taskFiles, testsDirectory) {
    const files = requireDeepSweFiles(taskFiles);
    await Promise.all([
      copyNormalized(
        files.verifierScriptPath,
        path.join(testsDirectory, 'test.sh'),
      ),
      copyNormalized(
        files.verifierPatchPath,
        path.join(testsDirectory, 'test.patch'),
      ),
    ]);
  },
  async auditVerifier({ workspace, testsDirectory, modelChangedFiles }) {
    const hiddenPatchChangedFiles = await patchChangedFiles(
      workspace,
      path.join(testsDirectory, 'test.patch'),
    );
    return {
      hiddenPatchChangedFiles,
      patchConflictFiles: auditVerifierPatchOverlap(
        modelChangedFiles,
        hiddenPatchChangedFiles,
      ),
    };
  },
};

function sweBenchProSuite(options: {
  readonly id: 'swe-bench-pro-calibration';
  readonly benchmarkId: 'ello.benchmark.swe-bench-pro.calibration';
  readonly displayName: string;
  readonly tasks: readonly SweBenchProTaskDeclaration[];
  readonly taskSetHash: string;
}): BenchmarkSuiteAdapter {
  const metadata: BenchmarkSuiteMetadata = {
    id: options.id,
    benchmarkId: options.benchmarkId,
    displayName: options.displayName,
    source: {
      repository: SWE_BENCH_PRO_SOURCE_REPOSITORY,
      revision: SWE_BENCH_PRO_SOURCE_REVISION,
    },
    taskSetHash: options.taskSetHash,
    selectedTaskCount: options.tasks.length,
    upstreamTaskCount: SWE_BENCH_PRO_DATASET_TASK_COUNT,
    selectionKind: 'calibration',
    scoreMetric: 'binary-reward',
  };
  return {
    metadata: {
      ...metadata,
    },
    taskBenchmark: 'swe-bench-pro',
    tasks: options.tasks,
    corpusCacheDirectory: 'swe-bench-pro',
    shellMode: 'preserve-environment',
    agentContainer: {
      entrypoint: '/bin/bash',
      command: ['-c', 'sleep infinity'],
    },
    verifierContainer: {
      entrypoint: '/bin/bash',
      command: [
        '-c',
        `mkdir -p ${CONTAINER_HOME} && exec python /tests/verifier.py`,
      ],
    },
    async loadTask(corpusRoot, declaration) {
      const loaded = await loadSweBenchProTask(
        corpusRoot,
        SweBenchProTaskDeclarationSchema.parse(declaration),
        await loadSweBenchProRows(corpusRoot, metadata.upstreamTaskCount),
      );
      return { benchmark: 'swe-bench-pro', ...loaded };
    },
    async loadTasks(corpusRoot) {
      const rows = await loadSweBenchProRows(
        corpusRoot,
        metadata.upstreamTaskCount,
      );
      return new Map(
        await Promise.all(
          options.tasks.map(
            async (declaration) =>
              [
                declaration.taskId,
                {
                  benchmark: 'swe-bench-pro' as const,
                  ...(await loadSweBenchProTask(corpusRoot, declaration, rows)),
                },
              ] as const,
          ),
        ),
      );
    },
    async prepareWorkspace(workspace, taskFiles, source) {
      const files = requireSweBenchProFiles(taskFiles);
      if (source === 'repository') {
        if (files.workspacePatch !== '') {
          await runChecked(
            'git',
            ['-C', workspace, 'apply', '--whitespace=nowarn', '--recount', '-'],
            {
              cwd: workspace,
              input: files.workspacePatch,
              timeoutMs: 10 * 60_000,
              killGraceMs: 5_000,
              maxOutputBytes: 128 * 1024 * 1024,
            },
          );
        }
        return;
      }
      for (const args of files.workspaceSetupCommands) {
        await runChecked('git', ['-C', workspace, ...args], {
          cwd: workspace,
          timeoutMs: 10 * 60_000,
          killGraceMs: 5_000,
          maxOutputBytes: 128 * 1024 * 1024,
        });
      }
    },
    async stageVerifier(taskFiles, testsDirectory) {
      const files = requireSweBenchProFiles(taskFiles);
      await Promise.all([
        copyNormalized(
          files.runScriptPath,
          path.join(testsDirectory, 'run_script.sh'),
        ),
        copyNormalized(
          files.parserPath,
          path.join(testsDirectory, 'parser.py'),
        ),
        writeFile(
          path.join(testsDirectory, 'verifier.py'),
          SWE_BENCH_PRO_VERIFIER,
          'utf8',
        ),
        writeJsonAtomic(path.join(testsDirectory, 'spec.json'), files.testSpec),
      ]);
    },
    auditVerifier: () =>
      Promise.resolve({
        hiddenPatchChangedFiles: [],
        patchConflictFiles: [],
      }),
  };
}

const SWE_BENCH_PRO = sweBenchProSuite({
  id: 'swe-bench-pro-calibration',
  benchmarkId: 'ello.benchmark.swe-bench-pro.calibration',
  displayName: 'SWE-bench Pro calibration',
  tasks: SWE_BENCH_PRO_TASKS,
  taskSetHash: SWE_BENCH_PRO_TASK_SET_HASH,
});

const SUITES = new Map<BenchmarkSuiteId, BenchmarkSuiteAdapter>([
  [DEEP_SWE.metadata.id, DEEP_SWE],
  [SWE_BENCH_PRO.metadata.id, SWE_BENCH_PRO],
]);

export function getBenchmarkSuite(id: BenchmarkSuiteId): BenchmarkSuiteAdapter {
  const suite = SUITES.get(id);
  if (suite === undefined) throw new Error(`Unknown benchmark suite: ${id}.`);
  return suite;
}

export function getBenchmarkSuiteById(
  benchmarkId: BenchmarkSuiteMetadata['benchmarkId'],
): BenchmarkSuiteAdapter {
  const suite = [...SUITES.values()].find(
    (candidate) => candidate.metadata.benchmarkId === benchmarkId,
  );
  if (suite === undefined) {
    throw new Error(`Unknown benchmark id: ${benchmarkId}.`);
  }
  return suite;
}

export function getBenchmarkSuiteForTask(
  benchmark: ResolvedTask['benchmark'],
): BenchmarkSuiteAdapter {
  const suite = [...SUITES.values()].find(
    (candidate) => candidate.taskBenchmark === benchmark,
  );
  if (suite === undefined) {
    throw new Error(`Unknown resolved task benchmark: ${benchmark}.`);
  }
  return suite;
}

function requireDeepSweFiles(taskFiles: ResolvedTaskFiles): LoadedDeepSweTask {
  if (taskFiles.benchmark !== 'deep-swe') {
    throw new Error('DeepSWE suite received SWE-bench Pro task files.');
  }
  return taskFiles;
}

function requireSweBenchProFiles(
  taskFiles: ResolvedTaskFiles,
): SweBenchProResolvedTaskFiles {
  if (taskFiles.benchmark !== 'swe-bench-pro') {
    throw new Error('SWE-bench Pro suite received DeepSWE task files.');
  }
  return taskFiles;
}

async function copyNormalized(source: string, target: string): Promise<void> {
  const content = (await readFile(source, 'utf8')).replaceAll('\r\n', '\n');
  await writeFile(target, content, 'utf8');
}
