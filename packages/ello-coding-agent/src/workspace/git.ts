import { spawn } from 'node:child_process';

/** 执行 git 命令，返回 stdout；失败时带 stderr 抛错。 */
export async function git(
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  return run('git', args, cwd);
}

export async function gitWithInput(
  args: readonly string[],
  input: string,
  cwd?: string,
): Promise<string> {
  return run('git', args, cwd, input);
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`${command} ${args.join(' ')} failed: ${stderr}`);
  }
}

/** 执行普通命令，供 tmux 等可选集成复用。 */
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
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    if (input !== undefined) {
      child.stdin!.on('error', reject);
      child.stdin!.end(input);
    }
    child.stdout!.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on('data', (chunk) => {
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
