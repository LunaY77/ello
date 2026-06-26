import { z } from 'zod';

import { BaseTool, type ToolArgs, type ToolRunContext } from '../base.js';

/** shell_exec 工具输入 schema。 */
export const ShellExecArgsSchema = z.object({
  command: z.string(),
  timeoutSeconds: z.number().positive().nullable().optional(),
  cwd: z.string().nullable().optional(),
});

/**
 * 执行 shell 命令并返回结果。
 */
export class ShellExecTool extends BaseTool {
  static override toolName = 'shell_exec';
  static override description =
    'Execute a shell command and return stdout, stderr, and exit code.';
  static override tags = new Set(['shell']);
  static override requiresApproval = true;
  static override inputSchema = ShellExecArgsSchema;

  /**
   * Shell 不存在时不可用。
   */
  override isAvailable(ctx: ToolRunContext): boolean {
    try {
      return ctx.deps.env.shell !== null;
    } catch {
      return false;
    }
  }

  /**
   * 执行 shell 命令。
   *
   * Args:
   *   ctx: 运行上下文。
   *   args.command: 要执行的命令。
   *   args.timeoutSeconds: 超时秒数; 为空时使用 toolConfig 默认值。
   *   args.cwd: 工作目录。
   *
   * Returns:
   *   包含 stdout, stderr, return_code 的字典。
   */
  async call(
    ctx: ToolRunContext,
    args: ToolArgs,
  ): Promise<Record<string, unknown>> {
    const parsed = ShellExecArgsSchema.parse(args);
    if (!parsed.command.trim()) {
      return {
        stdout: '',
        stderr: '',
        return_code: 1,
        error: 'Command cannot be empty.',
      };
    }

    const shell = ctx.deps.env.shell;
    if (shell === null) {
      return {
        stdout: '',
        stderr: '',
        return_code: 1,
        error: 'Shell not available.',
      };
    }

    const effectiveTimeoutSeconds =
      parsed.timeoutSeconds ?? ctx.deps.toolConfig.shellDefaultTimeoutSeconds;
    const truncateLimit = ctx.deps.toolConfig.shellOutputTruncateLimit;
    const result = await shell.run(parsed.command, {
      ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
      timeout: effectiveTimeoutSeconds * 1000,
    });

    return {
      stdout: truncate(result.stdout, truncateLimit),
      stderr: truncate(result.stderr, truncateLimit),
      return_code: result.exitCode,
    };
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, limit)}\n...(truncated)`
    : value;
}
