/**
 * 本文件负责基础设施层的“git”模块职责。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import { spawn } from 'node:child_process';

/**
 * 执行 git 命令，返回 stdout；失败时带 stderr 抛错。
 *
 * Args:
 * - `args`: `git` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - Promise 在 基础设施层的 `git` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function git(
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  return run('git', args, cwd);
}

/**
 * 执行 基础设施层的 `git` 模块 定义的 `gitWithInput` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `args`: `gitWithInput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 * - `input`: `gitWithInput` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - Promise 在 基础设施层的 `git` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function gitWithInput(
  args: readonly string[],
  input: string,
  cwd?: string,
): Promise<string> {
  return run('git', args, cwd, input);
}

export class CommandError extends Error {
  /**
   * 创建 `CommandError`，由该实例独占 基础设施层的 `git` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `command`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   * - `args`: `constructor CommandError` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `exitCode`: `constructor CommandError` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `stderr`: `constructor CommandError` 所需的业务值；函数按声明读取，不补造缺失内容。
   */
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`${command} ${args.join(' ')} failed: ${stderr}`);
  }
}

/**
 * 执行普通命令，供 tmux 等可选集成复用。
 *
 * Args:
 * - `command`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 * - `args`: `run` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `input`: `run` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - Promise 在 基础设施层的 `git` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 基础设施层的 `git` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function run(
  command: string,
  args: readonly string[],
  cwd?: string,
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream === null || stderrStream === null) {
      child.kill();
      throw new Error(`Command did not expose piped output: ${command}.`);
    }
    stdoutStream.setEncoding('utf8');
    stderrStream.setEncoding('utf8');
    if (input !== undefined) {
      const stdinStream = child.stdin;
      if (stdinStream === null) {
        child.kill();
        throw new Error(`Command did not expose piped input: ${command}.`);
      }
      stdinStream.on('error', reject);
      stdinStream.end(input);
    }
    stdoutStream.on('data', (chunk) => {
      stdout += chunk;
    });
    stderrStream.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new CommandError(command, args, code ?? -1, stderr.trim()));
      }
    });
  });
}
