import { z } from 'zod';

import { BaseTool, type ToolArgs, type ToolRunContext } from '../../base.js';

/** mkdir 工具输入 schema。 */
export const MkdirArgsSchema = z.object({
  path: z.string(),
});

/**
 * 创建目录。
 */
export class MkdirTool extends BaseTool {
  static override toolName = 'mkdir';
  static override description =
    'Create a directory (including parent directories).';
  static override inputSchema = MkdirArgsSchema;

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
   * 创建目录。
   */
  async call(ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    const parsed = MkdirArgsSchema.parse(args);
    const shell = ctx.deps.env.shell;
    if (shell === null) {
      return 'Error: shell not available.';
    }

    const result = await shell.run(`mkdir -p ${shellQuote(parsed.path)}`, {
      timeout: 10_000,
    });
    if (result.exitCode !== 0) {
      return `Error: ${result.stderr.trim() || 'Failed to create directory.'}`;
    }
    return `Successfully created directory: ${parsed.path}`;
  }
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}
