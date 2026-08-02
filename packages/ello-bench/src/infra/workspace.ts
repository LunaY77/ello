import { mkdir, statfs } from 'node:fs/promises';
import path from 'node:path';

import type { PreparedWorkspace } from '../ports/attempt.js';
import type { PullPolicy } from '../ports/container.js';
import type { ResolvedTaskFiles } from '../ports/corpus.js';

import { DockerContainerRuntime } from './container/docker.js';
import { CONTAINER_HOME } from './container-user.js';
import { getBenchmarkSuiteForTask } from './corpus/suite.js';
import { extractImageWorkspace } from './docker-image.js';
import { assertGitHead, captureBaselineTree } from './git-workspace.js';
import { runChecked } from './process.js';

const SHORT_PROCESS = {
  timeoutMs: 10 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 128 * 1024 * 1024,
} as const;

export const CONTAINER_RUNTIME_PROBE_COMMAND = [
  'sh',
  '-c',
  String.raw`printf '%s\n' "$(pwd)" "$(id -u):$(id -g)" "$HOME"`,
] as const;

export async function prepareTaskWorkspace(options: {
  readonly attemptId: string;
  readonly workspace: string;
  readonly taskFiles: ResolvedTaskFiles;
  readonly pullPolicy: PullPolicy;
}): Promise<PreparedWorkspace> {
  const task = options.taskFiles.task;
  const workspace = path.resolve(options.workspace);
  if (workspace.includes(',')) {
    throw new Error(`Docker bind path cannot contain a comma: ${workspace}`);
  }
  await assertWorkspaceCapacity(workspace, task.environment.storageMb);
  const suite = getBenchmarkSuiteForTask(task.benchmark);
  const seedContainer = containerName(options.attemptId, 'seed');
  const agentContainer = containerName(options.attemptId, 'agent');
  const runtime = new DockerContainerRuntime();
  const provenance = await runtime.ensureImage(
    task.environment.image,
    options.pullPolicy,
  );
  const imageId = await extractImageWorkspace({
    containerName: seedContainer,
    image: task.environment.image,
    workspace,
    timeoutMs: task.environment.buildTimeoutMs,
  });
  if (imageId !== provenance.imageId) {
    throw new Error(
      `Docker image changed during workspace preparation: ${provenance.imageId} versus ${imageId}.`,
    );
  }
  await suite.prepareWorkspace(workspace, options.taskFiles, 'image');
  await assertGitHead(workspace, task.baseCommitHash, 'Task image');
  const initialGitStatus = (
    await runChecked('git', ['-C', workspace, 'status', '--short'], {
      cwd: workspace,
      ...SHORT_PROCESS,
    })
  ).stdout;
  const baselineTree = await captureBaselineTree(workspace);
  const network = task.environment.allowInternet ? 'bridge' : 'none';
  const user = hostContainerIdentity();
  const containerUser = `${user.uid}:${user.gid}`;
  const container = await runtime.start({
    image: task.environment.image,
    name: agentContainer,
    workspaceMount: { host: workspace, container: '/app' },
    network,
    cpus: task.environment.cpus,
    memoryMb: task.environment.memoryMb,
    storageMb: task.environment.storageMb,
    env: { HOME: CONTAINER_HOME },
    user,
    ...(suite.agentContainer.entrypoint === undefined
      ? {}
      : { entrypoint: suite.agentContainer.entrypoint }),
    command: suite.agentContainer.command,
  });
  try {
    const home = await container.exec(['mkdir', '-p', CONTAINER_HOME], {
      cwd: container.workspace,
      timeoutMs: 30_000,
    });
    requireContainerSuccess(home, 'prepare HOME');
    const probe = await container.exec(CONTAINER_RUNTIME_PROBE_COMMAND, {
      cwd: container.workspace,
      timeoutMs: 30_000,
    });
    requireContainerSuccess(probe, 'probe runtime');
    const [containerCwd, containerId, containerHome] = (
      probe.stdout ?? ''
    ).split('\n');
    if (containerCwd !== '/app') {
      throw new Error(`Task container cwd mismatch: ${String(containerCwd)}`);
    }
    if (containerId !== containerUser) {
      throw new Error(
        `Task container user mismatch: ${String(containerId)} versus ${containerUser}.`,
      );
    }
    if (containerHome !== CONTAINER_HOME) {
      throw new Error(`Task container HOME mismatch: ${String(containerHome)}`);
    }
  } catch (error) {
    await container.remove();
    throw error;
  }
  return {
    workspace,
    container,
    containerUser,
    imageId,
    baselineTree,
    initialGitStatus,
    network,
  };
}

function containerName(attemptId: string, kind: 'seed' | 'agent'): string {
  if (!/^[0-9a-f]{24}$/u.test(attemptId)) {
    throw new Error(`Invalid attempt id for Docker container: ${attemptId}`);
  }
  return `ello-bench-${attemptId}-${kind}`;
}

function hostContainerIdentity(): {
  readonly uid: number;
  readonly gid: number;
} {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error('Benchmark containers require a POSIX host uid and gid.');
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

function requireContainerSuccess(
  execution: Awaited<
    ReturnType<import('../ports/container.js').ContainerHandle['exec']>
  >,
  operation: string,
): void {
  if (execution.process.exitCode !== 0 || execution.process.timedOut) {
    throw new Error(
      `Task container failed to ${operation}: ${execution.stderr ?? ''}`,
    );
  }
}

async function assertWorkspaceCapacity(
  workspace: string,
  requiredMb: number,
): Promise<void> {
  await mkdir(path.dirname(workspace), { recursive: true });
  const stats = await statfs(path.dirname(workspace));
  const available = Number(stats.bavail) * Number(stats.bsize);
  const required = requiredMb * 1024 * 1024;
  if (available < required) {
    throw new Error(
      `Workspace storage requirement is ${requiredMb} MiB, available bytes are ${available}.`,
    );
  }
}
