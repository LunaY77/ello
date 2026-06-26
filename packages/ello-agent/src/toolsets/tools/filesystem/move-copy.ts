import { z } from 'zod';

import { BaseTool, type ToolArgs, type ToolRunContext } from '../../base.js';

/** move_copy 工具输入 schema。 */
export const MoveCopyArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
  copy: z.boolean().default(false),
});

/**
 * 移动或复制文件。
 */
export class MoveCopyTool extends BaseTool {
  static override toolName = 'move_copy';
  static override description =
    'Move or copy a file/directory to a new location.';
  static override inputSchema = MoveCopyArgsSchema;

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
   * 移动或复制文件。
   */
  async call(ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    const parsed = MoveCopyArgsSchema.parse(args);
    const shell = ctx.deps.env.shell;
    if (shell === null) {
      return 'Error: shell not available.';
    }

    const cmd = parsed.copy
      ? `cp -r ${shellQuote(parsed.source)} ${shellQuote(parsed.destination)}`
      : `mv ${shellQuote(parsed.source)} ${shellQuote(parsed.destination)}`;
    const result = await shell.run(cmd, { timeout: 30_000 });
    if (result.exitCode !== 0) {
      return `Error: ${result.stderr.trim() || 'Operation failed.'}`;
    }

    const action = parsed.copy ? 'Copied' : 'Moved';
    return `${action} ${parsed.source} -> ${parsed.destination}`;
  }
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}
