/**
 * benchmark 将 AgentShell 调用映射到 job 专属 Docker container。
 *
 * 容器名、工作目录和命令分别作为进程参数传递，宿主机不会拼接执行字符串。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AgentShell, AgentShellResult } from '@ello/agent/runtime';

import {
  containerShellFlag,
  type ContainerShellMode,
} from './container-shell.js';

const execFileAsync = promisify(execFile);

export interface DockerShellEvent {
  readonly containerName: string;
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly failure?: string;
}

export interface DockerShellOptions {
  readonly containerName: string;
  readonly hostWorkspace: string;
  readonly containerWorkspace: string;
  readonly shellMode: ContainerShellMode;
  readonly record?: (event: DockerShellEvent) => Promise<void>;
  readonly execute?: DockerExecutor;
}

export type DockerExecutor = (
  args: ReadonlyArray<string>,
  timeout: number | undefined,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export function createDockerShell(options: DockerShellOptions): AgentShell {
  const hostWorkspace = path.resolve(options.hostWorkspace);
  if (options.containerName === '') {
    throw new Error('Docker shell requires a container name.');
  }
  if (!path.posix.isAbsolute(options.containerWorkspace)) {
    throw new Error('Docker shell requires an absolute container workspace.');
  }
  const execute = options.execute ?? executeDocker;
  return {
    async run(command, runOptions = {}) {
      if (command === '')
        throw new Error('Docker shell command must not be empty.');
      const cwd = mapContainerCwd(
        hostWorkspace,
        runOptions.cwd,
        options.containerWorkspace,
      );
      const args = [
        'exec',
        '--workdir',
        cwd.container,
        ...environmentArgs(runOptions.env),
        options.containerName,
        // 超时必须由容器内的 timeout(1) 施加：`docker exec` 的宿主超时只能向
        // docker CLI 发 SIGTERM，而 CLI 收到它后以 0 干净退出、不带 signal，
        // 于是 execFile 走 resolve 分支，超时对调用方完全不可见。容器内
        // timeout 返回 124，该退出码经 CLI 原样穿透。timeout 必须包住整条
        // 管道，否则退出码取自管道最后一段（如 tail）而丢失 124。
        ...containerTimeoutArgs(runOptions.timeout),
        'sh',
        containerShellFlag(options.shellMode),
        command,
      ];
      const startedAt = performance.now();
      try {
        const result = await execute(args, hostTimeout(runOptions.timeout));
        const output: AgentShellResult = {
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: false,
        };
        await options.record?.({
          containerName: options.containerName,
          command,
          cwd: cwd.container,
          ...(runOptions.timeout === undefined
            ? {}
            : { timeoutMs: runOptions.timeout }),
          durationMs: performance.now() - startedAt,
          exitCode: output.exitCode,
          stdoutBytes: Buffer.byteLength(output.stdout),
          stderrBytes: Buffer.byteLength(output.stderr),
        });
        return output;
      } catch (error) {
        if (!isDockerCommandFailure(error)) {
          await options.record?.({
            containerName: options.containerName,
            command,
            cwd: cwd.container,
            ...(runOptions.timeout === undefined
              ? {}
              : { timeoutMs: runOptions.timeout }),
            durationMs: performance.now() - startedAt,
            failure: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const exitCode =
          error.killed === true ? -1 : requireDockerExitCode(error.code);
        if (error.stderr.includes('No such container')) {
          await options.record?.({
            containerName: options.containerName,
            command,
            cwd: cwd.container,
            ...(runOptions.timeout === undefined
              ? {}
              : { timeoutMs: runOptions.timeout }),
            durationMs: performance.now() - startedAt,
            exitCode,
            stdoutBytes: Buffer.byteLength(error.stdout),
            stderrBytes: Buffer.byteLength(error.stderr),
            failure: `Docker container is unavailable: ${options.containerName}`,
          });
          throw new Error(
            `Docker container is unavailable: ${options.containerName}`,
            {
              cause: error,
            },
          );
        }
        // 超时进程被终止，已产出的 stderr 仍是唯一的失败线索，必须原样保留。
        // 124 是容器内 timeout(1) 的超时退出码；killed 表示宿主兜底超时先于
        // 容器内超时触发，两者都是超时。
        const output: AgentShellResult = {
          exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
          timedOut:
            error.killed === true || exitCode === CONTAINER_TIMEOUT_EXIT_CODE,
        };
        await options.record?.({
          containerName: options.containerName,
          command,
          cwd: cwd.container,
          ...(runOptions.timeout === undefined
            ? {}
            : { timeoutMs: runOptions.timeout }),
          durationMs: performance.now() - startedAt,
          exitCode: output.exitCode,
          stdoutBytes: Buffer.byteLength(output.stdout),
          stderrBytes: Buffer.byteLength(output.stderr),
        });
        return output;
      }
    },
    getContextInstructions: () =>
      [
        '<shell>',
        `  <container>${options.containerName}</container>`,
        `  <working-directory>${options.containerWorkspace}</working-directory>`,
        '</shell>',
      ].join('\n'),
  };
}

/** 容器内 timeout(1) 因超时终止命令时的退出码。 */
const CONTAINER_TIMEOUT_EXIT_CODE = 124;

/** 容器内进程收到 SIGTERM 后仍未退出时，升级为 SIGKILL 的等待时间。 */
const CONTAINER_TIMEOUT_KILL_AFTER_MS = 5_000;

/** 宿主兜底超时相对容器内超时的额外余量，确保容器内超时总是先触发。 */
const HOST_TIMEOUT_MARGIN_MS = 15_000;

/**
 * 构造容器内 timeout(1) 的前缀参数。
 *
 * Args:
 * - `timeoutMs`: 调用方要求的超时；未指定时不施加容器内超时。
 *
 * Returns:
 * - 返回插入到容器命令之前的 timeout 参数；无超时要求时返回空数组。
 */
function containerTimeoutArgs(timeoutMs: number | undefined): string[] {
  if (timeoutMs === undefined) return [];
  // timeout(1) 的 DURATION 支持小数秒，毫秒精度无需取整为整秒。
  return [
    'timeout',
    '--signal=TERM',
    `--kill-after=${CONTAINER_TIMEOUT_KILL_AFTER_MS / 1000}s`,
    `${timeoutMs / 1000}s`,
  ];
}

/**
 * 计算宿主侧兜底超时。
 *
 * 容器内 timeout 是主超时；宿主超时只在 docker CLI 自身卡死时生效，因此必须
 * 比容器内超时更宽，否则会抢先杀掉 CLI 并重新引入超时不可见的问题。
 *
 * Args:
 * - `timeoutMs`: 调用方要求的超时；未指定时宿主侧同样不设超时。
 *
 * Returns:
 * - 返回宿主 execFile 使用的超时毫秒数，或 undefined 表示不限时。
 */
function hostTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  return timeoutMs + CONTAINER_TIMEOUT_KILL_AFTER_MS + HOST_TIMEOUT_MARGIN_MS;
}

function environmentArgs(env: Record<string, string> | undefined): string[] {
  if (env === undefined) return [];
  return Object.entries(env).flatMap(([key, value]) => [
    '--env',
    `${key}=${value}`,
  ]);
}

function mapContainerCwd(
  hostWorkspace: string,
  requestedCwd: string | undefined,
  containerWorkspace: string,
): { readonly host: string; readonly container: string } {
  const host = path.resolve(hostWorkspace, requestedCwd ?? hostWorkspace);
  const relative = path.relative(hostWorkspace, host);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Docker shell cwd escapes job workspace: ${host}`);
  }
  const container = path.posix.join(
    containerWorkspace,
    ...relative.split(path.sep).filter((part) => part !== ''),
  );
  return { host, container };
}

async function executeDocker(
  args: ReadonlyArray<string>,
  timeout: number | undefined,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync('docker', [...args], {
    ...(timeout === undefined ? {} : { timeout }),
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function requireDockerExitCode(code: number | null): number {
  if (typeof code !== 'number') {
    throw new Error('Docker command failure is missing a numeric exit code.');
  }
  return code;
}

function isDockerCommandFailure(error: unknown): error is Error & {
  readonly code: number | null;
  readonly killed?: boolean;
  readonly stdout: string;
  readonly stderr: string;
} {
  return (
    error instanceof Error &&
    'code' in error &&
    (typeof error.code === 'number' ||
      (error.code === null && 'killed' in error && error.killed === true)) &&
    'stdout' in error &&
    typeof error.stdout === 'string' &&
    'stderr' in error &&
    typeof error.stderr === 'string'
  );
}
