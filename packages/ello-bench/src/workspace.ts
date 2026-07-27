import { mkdir, statfs } from 'node:fs/promises';
import path from 'node:path';

import { CONTAINER_HOME, hostContainerUser } from './container-user.js';
import type { ResolvedTask } from './contracts.js';
import { extractImageWorkspace, removeContainer } from './docker-image.js';
import { assertGitHead, captureBaselineTree } from './git-workspace.js';
import { runChecked } from './process.js';
import { getBenchmarkSuiteForTask } from './suite.js';
import type { ResolvedTaskFiles } from './task-corpus.js';

const SHORT_PROCESS = {
  timeoutMs: 10 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 128 * 1024 * 1024,
} as const;

export interface PreparedWorkspace {
  readonly workspace: string;
  readonly containerName: string;
  readonly containerWorkspace: '/app';
  readonly containerUser: string;
  readonly imageId: string;
  readonly baselineTree: string;
  readonly initialGitStatus: string;
  readonly network: 'none' | 'bridge';
}

export async function prepareTaskWorkspace(options: {
  readonly attemptId: string;
  readonly workspace: string;
  readonly taskFiles: ResolvedTaskFiles;
}): Promise<PreparedWorkspace> {
  const task = options.taskFiles.task;
  const workspace = path.resolve(options.workspace);
  if (workspace.includes(',')) {
    throw new Error(`Docker bind path cannot contain a comma: ${workspace}`);
  }
  await assertWorkspaceCapacity(workspace, task.environment.storageMb);
  const seedContainer = containerName(options.attemptId, 'seed');
  const agentContainer = containerName(options.attemptId, 'agent');
  await removeContainer(agentContainer);
  const imageId = await extractImageWorkspace({
    containerName: seedContainer,
    image: task.environment.image,
    workspace,
    timeoutMs: task.environment.buildTimeoutMs,
  });
  const suite = getBenchmarkSuiteForTask(task.benchmark);
  await suite.prepareWorkspace(workspace, options.taskFiles);
  await assertGitHead(workspace, task.baseCommitHash, 'Task image');
  const initialGitStatus = (
    await runChecked('git', ['-C', workspace, 'status', '--short'], {
      cwd: workspace,
      ...SHORT_PROCESS,
    })
  ).stdout;
  const baselineTree = await captureBaselineTree(workspace);
  const network = task.environment.allowInternet ? 'bridge' : 'none';
  const containerUser = hostContainerUser();
  await runChecked(
    'docker',
    taskContainerDockerArgs({
      containerName: agentContainer,
      workspace,
      network,
      containerUser,
      task,
    }),
    { cwd: workspace, ...SHORT_PROCESS },
  );
  await runChecked(
    'docker',
    ['exec', agentContainer, 'mkdir', '-p', CONTAINER_HOME],
    { cwd: workspace, ...SHORT_PROCESS },
  );
  const probe = (
    await runChecked(
      'docker',
      [
        'exec',
        '--workdir',
        '/app',
        agentContainer,
        'sh',
        '-c',
        'printf %s\\\\n "$(pwd)" "$(id -u):$(id -g)" "$HOME"',
      ],
      { cwd: workspace, ...SHORT_PROCESS },
    )
  ).stdout.split('\n');
  const [containerCwd, containerId, containerHome] = probe;
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
  return {
    workspace,
    containerName: agentContainer,
    containerWorkspace: '/app',
    containerUser,
    imageId,
    baselineTree,
    initialGitStatus,
    network,
  };
}

export function taskContainerDockerArgs(options: {
  readonly containerName: string;
  readonly workspace: string;
  readonly network: 'none' | 'bridge';
  readonly containerUser: string;
  readonly task: ResolvedTask;
}): string[] {
  const suite = getBenchmarkSuiteForTask(options.task.benchmark);
  const args = [
    'run',
    '-d',
    '--init',
    '--name',
    options.containerName,
    '--user',
    options.containerUser,
    // 镜像默认 HOME=/root 对非 root 用户不可写，Git 与 npm 的全局配置会失败。
    '--env',
    `HOME=${CONTAINER_HOME}`,
    '--network',
    options.network,
    '--cpus',
    String(options.task.environment.cpus),
    '--memory',
    `${options.task.environment.memoryMb}m`,
    '--mount',
    `type=bind,source=${options.workspace},target=/app`,
    '--workdir',
    '/app',
  ];
  if (suite.agentContainer.entrypoint !== undefined) {
    args.push('--entrypoint', suite.agentContainer.entrypoint);
  }
  args.push(options.task.environment.image, ...suite.agentContainer.command);
  return args;
}

function containerName(attemptId: string, kind: 'seed' | 'agent'): string {
  if (!/^[0-9a-f]{24}$/u.test(attemptId)) {
    throw new Error(`Invalid attempt id for Docker container: ${attemptId}`);
  }
  return `ello-bench-${attemptId}-${kind}`;
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
