import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ArtifactReferenceSchema,
  VerifierProcessArtifactSchema,
  type ArtifactReference,
  type ResolvedTask,
} from '../../domain/contract/index.js';
import { sha256 } from '../../domain/hash.js';
import { dockerContainerWritableBytes } from '../container/docker.js';
import { CONTAINER_HOME, hostContainerUser } from '../container-user.js';
import { getBenchmarkSuiteForTask } from '../corpus/suite.js';
import { removeContainer } from '../docker-image.js';
import { errorMessage, writeJsonAtomic } from '../io.js';
import { runProcess } from '../process.js';
import {
  STORAGE_WATCHDOG_INTERVAL_MS,
  WorkspaceStorageWatchdog,
} from '../workspace-storage.js';

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
}): Promise<{
  readonly reference: ArtifactReference;
  readonly baselineExitCode: number;
  readonly newTestsExitCode: number;
}> {
  const verifierName = `ello-bench-${options.attemptId}-verify`;
  await removeContainer(verifierName);
  const stdoutPath = path.join(options.harnessRoot, 'stdout.log');
  const stderrPath = path.join(options.harnessRoot, 'stderr.log');
  const startedAt = new Date().toISOString();
  let execution: Awaited<ReturnType<typeof runProcess>> | undefined;
  let cleanupError: unknown;
  let storageError: unknown;
  const storage = new WorkspaceStorageWatchdog(
    options.workspace,
    options.task.environment.storageMb * 1024 * 1024,
    STORAGE_WATCHDOG_INTERVAL_MS,
    () => removeContainer(verifierName),
    () => dockerContainerWritableBytes(verifierName),
  );
  await storage.start();
  try {
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
  } finally {
    try {
      await storage.assertWithinLimit();
    } catch (error) {
      storageError = error;
    }
    await storage.stop();
    try {
      await removeContainer(verifierName);
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
    storagePolicy: {
      enforcement: 'workspace-and-writable-layer-watchdog',
      accounting: ['bind-workspace-apparent-bytes', 'container-size-rw'],
      limitBytes: options.task.environment.storageMb * 1024 * 1024,
      intervalMs: STORAGE_WATCHDOG_INTERVAL_MS,
    },
  });
  if (cleanupError !== undefined) {
    throw new VerifierExecutionError(
      `Verifier runtime cleanup failed: ${errorMessage(cleanupError)}`,
      evidence.reference,
    );
  }
  if (storageError !== undefined) {
    throw new VerifierExecutionError(
      `Verifier workspace storage enforcement failed: ${errorMessage(storageError)}`,
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
  readonly storagePolicy: {
    readonly enforcement: 'workspace-and-writable-layer-watchdog';
    readonly accounting: readonly [
      'bind-workspace-apparent-bytes',
      'container-size-rw',
    ];
    readonly limitBytes: number;
    readonly intervalMs: number;
  };
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
    storagePolicy: options.storagePolicy,
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
