/**
 * 环境 feature 提供受路径策略约束的本地 Agent shell 实现。
 *
 * shell 命令只可在当前写路径视图覆盖的工作目录中运行。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentShell } from '../agent/engine/contracts.js';

import { environmentInstructions } from './instructions.js';
import { resolveAllowedTarget } from './paths.js';

const execAsync = promisify(exec);

/**
 * 默认 shell 固定为 bash，因为退出码语义依赖 `pipefail`：
 * `/bin/sh`（dash）不支持该选项，管道会把退出码替换成最后一个过滤器的。
 */
const DEFAULT_SHELL = '/bin/bash';

/**
 * 让管道命令的退出码反映首个失败环节，而不是最后一个过滤器。
 *
 * `cmd | tail` 是日常习惯写法，默认语义下 `tail` 成功即整条命令成功，
 * 真实失败码被吞掉。开启 `pipefail` 后退出码不再取决于调用方怎么写管道。
 */
function pipefail(command: string): string {
  return `set -o pipefail; ${command}`;
}

/**
 * 创建本地进程 shell，并在运行前验证命令工作目录。
 *
 * Args:
 * - `cwd`: 当前运行的规范工作目录。
 * - `allowedPaths`: 每次命令执行读取允许根目录的函数。
 * - `shellExecutable`: 可选的 shell 可执行文件。
 *
 * Returns:
 * - 返回实现 Agent shell 协议的本地执行 adapter。
 */
export function createPolicyShell(
  cwd: string,
  allowedPaths: () => ReadonlyArray<string>,
  shellExecutable: string | undefined,
): AgentShell {
  return {
    async run(command, options = {}) {
      const resolvedCwd = resolveAllowedTarget(
        cwd,
        options.cwd ?? cwd,
        allowedPaths(),
      );
      try {
        const result = await execAsync(pipefail(command), {
          cwd: resolvedCwd,
          timeout: options.timeout,
          env:
            options.env === undefined
              ? process.env
              : { ...process.env, ...options.env },
          shell: shellExecutable ?? DEFAULT_SHELL,
        });
        return {
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: false,
        };
      } catch (error) {
        return shellFailureResult(error);
      }
    },
    getContextInstructions: () =>
      environmentInstructions('shell', cwd, allowedPaths(), shellExecutable),
  };
}

function shellFailureResult(error: unknown): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
} {
  if (!(error instanceof Error)) {
    throw new TypeError('Shell execution rejected with a non-Error value.', {
      cause: error,
    });
  }
  const record: object = error;
  const killed = readBooleanProperty(record, 'killed') === true;
  const code = readProperty(record, 'code');
  const stdout = requireStringProperty(record, 'stdout');
  const stderr = requireStringProperty(record, 'stderr');
  let exitCode: number;
  if (killed) {
    exitCode = -1;
  } else {
    if (typeof code !== 'number') {
      throw new Error('Shell command failure is missing a numeric exit code.', {
        cause: error,
      });
    }
    exitCode = code;
  }
  // 超时进程被 SIGTERM 终止，已产出的 stderr 仍是唯一的失败线索，必须原样保留。
  return { exitCode, stdout, stderr, timedOut: killed };
}

function readProperty(value: object, key: string): unknown {
  return key in value ? Reflect.get(value, key) : undefined;
}

function requireStringProperty(value: object, key: string): string {
  const property = readProperty(value, key);
  if (typeof property !== 'string') {
    throw new TypeError(`Shell command failure is missing string ${key}.`);
  }
  return property;
}

function readBooleanProperty(value: object, key: string): boolean | undefined {
  const property = readProperty(value, key);
  return typeof property === 'boolean' ? property : undefined;
}
