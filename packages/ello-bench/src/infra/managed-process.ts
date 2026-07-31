/**
 * benchmark 基础设施的流式宿主进程原语。
 *
 * Container adapter 用它承接 Docker CLI 或 Fake Container 的真实子进程；超时、输出保留与
 * Environment Process Reference 仍由上层 Environment registry 管理。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  ContainerProcess,
  ContainerProcessSignal,
  ContainerSpawnOptions,
} from '../ports/container.js';

export interface SpawnManagedProcessOptions
  extends Omit<ContainerSpawnOptions, 'env'> {
  readonly env?: NodeJS.ProcessEnv;
}

/** 启动一个保留 stdin 与分流输出的宿主进程。 */
export async function spawnManagedProcess(
  command: string,
  args: readonly string[],
  options: SpawnManagedProcessOptions,
): Promise<ContainerProcess> {
  if (command === '') throw new Error('Managed process command is empty.');
  const startedAt = performance.now();
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk: Buffer) => options.onStdout(chunk));
  child.stderr.on('data', (chunk: Buffer) => options.onStderr(chunk));

  let settled = false;
  const exit = new Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly durationMs: number;
  }>((resolve, reject) => {
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        signal,
        durationMs: performance.now() - startedAt,
      });
    });
  });
  void exit.catch(() => undefined);
  await waitForSpawn(child);

  return {
    exit,
    write: (data) => writeStdin(child, data),
    closeStdin: () => closeStdin(child),
    signal: (signal) => {
      signalProcessTree(child.pid, signal);
      return Promise.resolve();
    },
  };
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function writeStdin(
  child: ChildProcessWithoutNullStreams,
  data: Uint8Array,
): Promise<void> {
  if (child.stdin.destroyed || child.stdin.writableEnded) {
    return Promise.reject(new Error('Managed process stdin is closed.'));
  }
  return new Promise((resolve, reject) => {
    child.stdin.write(data, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function closeStdin(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.stdin.destroyed || child.stdin.writableEnded) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.stdin.end((error?: Error | null) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function signalProcessTree(
  pid: number | undefined,
  signal: ContainerProcessSignal,
): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}
