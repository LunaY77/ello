import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CONTAINER_HOME, hostContainerUser } from './container-user.js';
import {
  ArtifactReferenceSchema,
  VerifierProcessArtifactSchema,
  type ArtifactReference,
  type ResolvedTask,
} from './contracts.js';
import { removeContainer } from './docker-image.js';
import { sha256 } from './hash.js';
import { errorMessage, writeJsonAtomic } from './io.js';
import { runProcess } from './process.js';
import { getBenchmarkSuiteForTask } from './suite.js';

export class VerifierExecutionError extends Error {
  readonly processEvidence: ArtifactReference;

  constructor(message: string, processEvidence: ArtifactReference) {
    super(message);
    this.name = 'VerifierExecutionError';
    this.processEvidence = processEvidence;
  }
}

export async function executeVerifierProcess(options: {
  readonly attemptId: string;
  readonly harnessRoot: string;
  readonly workspace: string;
  readonly tests: string;
  readonly logs: string;
  readonly task: ResolvedTask;
  readonly runtime: 'docker' | 'local';
}): Promise<{
  readonly reference: ArtifactReference;
  readonly baselineExitCode: number;
  readonly newTestsExitCode: number;
}> {
  const verifierName = `ello-bench-${options.attemptId}-verify`;
  if (options.runtime === 'docker') await removeContainer(verifierName);
  const stdoutPath = path.join(options.harnessRoot, 'stdout.log');
  const stderrPath = path.join(options.harnessRoot, 'stderr.log');
  const startedAt = new Date().toISOString();
  let execution: Awaited<ReturnType<typeof runProcess>> | undefined;
  let cleanupError: unknown;
  let compatibilityRoot: string | undefined;
  try {
    if (options.runtime === 'docker') {
      execution = await runProcess(
        'docker',
        verifierDockerArgs(options, verifierName, hostContainerUser()),
        {
          cwd: options.harnessRoot,
          timeoutMs: options.task.verifierTimeoutMs,
          killGraceMs: 10_000,
          capture: false,
          stdoutPath,
          stderrPath,
        },
      );
    } else {
      compatibilityRoot = await prepareLocalCompatibilityRoot(options);
      const local = localVerifierCommand(options, compatibilityRoot);
      execution = await runProcess(local.command, local.args, {
        cwd: path.join(compatibilityRoot, 'app'),
        env: process.env,
        timeoutMs: options.task.verifierTimeoutMs,
        killGraceMs: 10_000,
        capture: false,
        stdoutPath,
        stderrPath,
      });
    }
  } finally {
    try {
      if (options.runtime === 'docker') {
        await removeContainer(verifierName);
      } else if (compatibilityRoot !== undefined) {
        await rm(compatibilityRoot, { recursive: true, force: true });
      }
    } catch (error) {
      cleanupError = error;
    }
  }
  if (execution === undefined) {
    throw new Error('Verifier process result is missing.');
  }
  const evidence = await writeProcessEvidence({
    harnessRoot: options.harnessRoot,
    startedAt,
    completedAt: new Date().toISOString(),
    execution: execution.result,
    stdoutPath,
    stderrPath,
  });
  if (cleanupError !== undefined) {
    throw new VerifierExecutionError(
      `Verifier runtime cleanup failed: ${errorMessage(cleanupError)}`,
      evidence.reference,
    );
  }
  if (execution.result.timedOut) {
    throw new VerifierExecutionError('Verifier timed out.', evidence.reference);
  }
  if (execution.result.exitCode !== 0) {
    throw new VerifierExecutionError(
      `Verifier exited with code ${String(execution.result.exitCode)}.`,
      evidence.reference,
    );
  }
  const { baselineExitCode, newTestsExitCode } = evidence.testResults;
  if (baselineExitCode === null || newTestsExitCode === null) {
    throw new VerifierExecutionError(
      'Verifier test exit-code markers are incomplete.',
      evidence.reference,
    );
  }
  return { reference: evidence.reference, baselineExitCode, newTestsExitCode };
}

async function prepareLocalCompatibilityRoot(options: {
  readonly workspace: string;
  readonly tests: string;
  readonly logs: string;
  readonly task: ResolvedTask;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-verifier-'));
  try {
    await Promise.all([
      symlink(options.workspace, path.join(root, 'app'), 'dir'),
      symlink(options.tests, path.join(root, 'tests'), 'dir'),
      symlink(options.logs, path.join(root, 'logs'), 'dir'),
    ]);
    const scripts =
      options.task.benchmark === 'deep-swe'
        ? [path.join(options.tests, 'test.sh')]
        : [
            path.join(options.tests, 'verifier.py'),
            path.join(options.tests, 'run_script.sh'),
          ];
    await Promise.all(
      scripts.map(async (script) => {
        const source = await readFile(script, 'utf8');
        await writeFile(
          script,
          rewriteContainerRoot(
            rewriteContainerRoot(
              rewriteContainerRoot(
                source,
                '/tests',
                path.join(root, 'tests'),
              ),
              '/logs',
              path.join(root, 'logs'),
            ),
            '/app',
            path.join(root, 'app'),
          ),
          'utf8',
        );
      }),
    );
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function rewriteContainerRoot(
  source: string,
  containerRoot: '/app' | '/tests' | '/logs',
  localRoot: string,
): string {
  const escaped = containerRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_.-])${escaped}(?=/|[^A-Za-z0-9_.-]|$)`,
    'gmu',
  );
  return source.replace(
    pattern,
    (_match, prefix: string) => `${prefix}${localRoot}`,
  );
}

export function localVerifierCommand(
  options: {
    readonly tests: string;
    readonly task: ResolvedTask;
  },
  compatibilityRoot: string,
): { readonly command: string; readonly args: readonly string[] } {
  if (options.task.benchmark === 'deep-swe') {
    return {
      command: '/bin/bash',
      args: [path.join(compatibilityRoot, 'tests', 'test.sh')],
    };
  }
  return {
    command: process.env.PYTHON ?? 'python3',
    args: [path.join(compatibilityRoot, 'tests', 'verifier.py')],
  };
}

export function verifierDockerArgs(
  options: {
    readonly workspace: string;
    readonly tests: string;
    readonly logs: string;
    readonly task: ResolvedTask;
  },
  verifierName: string,
  containerUser: string,
): string[] {
  const task = options.task;
  const suite = getBenchmarkSuiteForTask(task.benchmark);
  const args = [
    'run',
    '--rm',
    '--name',
    verifierName,
    '--user',
    containerUser,
    // 镜像默认 HOME=/root 对非 root 用户不可写，test.sh 的
    // `git config --global --add safe.directory` 会静默失败。
    '--env',
    `HOME=${CONTAINER_HOME}`,
    '--network',
    task.environment.allowInternet ? 'bridge' : 'none',
    '--cpus',
    String(task.environment.cpus),
    '--memory',
    `${task.environment.memoryMb}m`,
    '--mount',
    `type=bind,source=${options.workspace},target=/app`,
    '--mount',
    `type=bind,source=${options.tests},target=/tests,readonly`,
    '--mount',
    `type=bind,source=${options.logs},target=/logs`,
  ];
  if (suite.verifierContainer.entrypoint !== undefined) {
    args.push('--entrypoint', suite.verifierContainer.entrypoint);
  }
  args.push(task.environment.image, ...suite.verifierContainer.command);
  return args;
}

async function writeProcessEvidence(options: {
  readonly harnessRoot: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly execution: Awaited<ReturnType<typeof runProcess>>['result'];
  readonly stdoutPath: string;
  readonly stderrPath: string;
}) {
  const [stdout, stderr] = await Promise.all([
    readFile(options.stdoutPath),
    readFile(options.stderrPath),
  ]);
  const artifact = VerifierProcessArtifactSchema.parse({
    schema: 'ello.benchmark.verifier-process.v1',
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    process: options.execution,
    testResults: parseVerifierTestResults(stdout.toString('utf8')),
    stdout: {
      path: options.stdoutPath,
      sha256: sha256(stdout),
      bytes: stdout.byteLength,
    },
    stderr: {
      path: options.stderrPath,
      sha256: sha256(stderr),
      bytes: stderr.byteLength,
    },
  });
  const artifactPath = path.join(options.harnessRoot, 'process.json');
  await writeJsonAtomic(artifactPath, artifact);
  return {
    reference: ArtifactReferenceSchema.parse({
      path: artifactPath,
      sha256: sha256(await readFile(artifactPath)),
    }),
    testResults: artifact.testResults,
  };
}

export function parseVerifierTestResults(stdout: string): {
  readonly baselineExitCode: number | null;
  readonly newTestsExitCode: number | null;
} {
  return {
    baselineExitCode: parseExitCodeMarker(stdout, 'Baseline exit code'),
    newTestsExitCode: parseExitCodeMarker(stdout, 'New tests exit code'),
  };
}

function parseExitCodeMarker(stdout: string, label: string): number | null {
  const matches = [
    ...stdout.matchAll(new RegExp(`^\\[verifier\\] ${label}: (\\d+)$`, 'gmu')),
  ];
  if (matches.length > 1) {
    throw new Error(`Verifier emitted duplicate ${label} markers.`);
  }
  const value = matches[0]?.[1];
  return value === undefined ? null : Number(value);
}
