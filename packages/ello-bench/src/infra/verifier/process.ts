import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ArtifactReferenceSchema,
  VerifierProcessArtifactSchema,
  type ArtifactReference,
  type ProcessResult,
  type ResolvedTask,
} from '../../domain/contract/index.js';
import { sha256 } from '../../domain/hash.js';
import type { ContainerHandle, ContainerSpec } from '../../ports/container.js';
import { DockerContainerRuntime } from '../container/docker.js';
import { CONTAINER_HOME, hostContainerIdentity } from '../container-user.js';
import { getBenchmarkSuiteForTask } from '../corpus/suite.js';
import { errorMessage, writeJsonAtomic } from '../io.js';

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
  const stdoutPath = path.join(options.harnessRoot, 'stdout.log');
  const stderrPath = path.join(options.harnessRoot, 'stderr.log');
  const startedAt = new Date().toISOString();
  let execution: ProcessResult | undefined;
  let storagePolicy: ContainerHandle['storagePolicy'] | undefined;
  let cleanupError: unknown;
  let storageError: unknown;
  const runtime = new DockerContainerRuntime();
  let container: ContainerHandle | undefined;
  try {
    container = await runtime.start(
      verifierContainerSpec(options, verifierName),
    );
    storagePolicy = container.storagePolicy;
    execution = (
      await container.exec(verifierCommand(options.task), {
        cwd: container.workspace,
        timeoutMs: options.task.verifierTimeoutMs,
        killGraceMs: 10_000,
        stdoutPath,
        stderrPath,
      })
    ).process;
  } finally {
    if (container !== undefined) {
      try {
        await container.assertStorageLimit();
      } catch (error) {
        storageError = error;
      }
      try {
        await container.remove();
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (execution === undefined) {
    throw new Error('Verifier process result is missing.');
  }
  const evidence = await writeProcessEvidence({
    harnessRoot: options.harnessRoot,
    startedAt,
    completedAt: new Date().toISOString(),
    execution,
    stdoutPath,
    stderrPath,
    storagePolicy: requiredStoragePolicy(storagePolicy),
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
  if (execution.timedOut) {
    throw new VerifierExecutionError('Verifier timed out.', evidence.reference);
  }
  if (execution.exitCode !== 0) {
    throw new VerifierExecutionError(
      `Verifier exited with code ${String(execution.exitCode)}.`,
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

export function verifierContainerSpec(
  options: {
    readonly workspace: string;
    readonly tests: string;
    readonly logs: string;
    readonly task: ResolvedTask;
  },
  verifierName: string,
): ContainerSpec {
  const task = options.task;
  return {
    image: task.environment.image,
    name: verifierName,
    workspaceMount: { host: options.workspace, container: '/app' },
    additionalMounts: [
      { host: options.tests, container: '/tests', readOnly: true },
      { host: options.logs, container: '/logs' },
    ],
    network: task.environment.allowInternet ? 'bridge' : 'none',
    cpus: task.environment.cpus,
    memoryMb: task.environment.memoryMb,
    storageMb: task.environment.storageMb,
    env: { HOME: CONTAINER_HOME },
    user: hostContainerIdentity(),
    entrypoint: '/bin/sh',
    command: ['-c', 'sleep infinity'],
  };
}

export function verifierCommand(task: ResolvedTask): readonly string[] {
  const suite = getBenchmarkSuiteForTask(task.benchmark);
  return suite.verifierContainer.entrypoint === undefined
    ? [...suite.verifierContainer.command]
    : [suite.verifierContainer.entrypoint, ...suite.verifierContainer.command];
}

async function writeProcessEvidence(options: {
  readonly harnessRoot: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly execution: ProcessResult;
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

function requiredStoragePolicy(
  value: ContainerHandle['storagePolicy'] | undefined,
): NonNullable<typeof value> {
  if (value === undefined)
    throw new Error('Verifier storage policy is missing.');
  return value;
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
