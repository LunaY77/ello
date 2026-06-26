import { z } from "zod";
import { BaseTool, type ToolArgs, type ToolRunContext } from "../../base.js";

/** delete_file 工具输入 schema。 */
export const DeleteFileArgsSchema = z.object({
  path: z.string(),
});

/**
 * 删除文件。
 */
export class DeleteFileTool extends BaseTool {
  static override toolName = "delete_file";
  static override description = "Delete a file from the filesystem.";
  static override inputSchema = DeleteFileArgsSchema;

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
   * 删除指定文件。
   */
  async call(ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    const parsed = DeleteFileArgsSchema.parse(args);
    const shell = ctx.deps.env.shell;
    if (shell === null) {
      return "Error: shell not available.";
    }

    const result = await shell.run(`rm -f ${shellQuote(parsed.path)}`, { timeout: 10_000 });
    if (result.exitCode !== 0) {
      return `Error: ${result.stderr.trim() || "Failed to delete file."}`;
    }
    return `Successfully deleted: ${parsed.path}`;
  }
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}
