import { z } from "zod";
import { BaseTool, type ToolArgs, type ToolRunContext } from "../base.js";

/** list_dir 工具输入 schema。 */
export const ListDirArgsSchema = z.object({
  path: z.string().default("."),
});

/**
 * 列出目录内容。
 */
export class ListDirTool extends BaseTool {
  static override toolName = "list_dir";
  static override description = "List files and subdirectories in a directory.";
  static override supersededByTags = new Set(["shell"]);
  static override inputSchema = ListDirArgsSchema;

  /**
   * FileOperator 不存在时不可用。
   */
  override isAvailable(ctx: ToolRunContext): boolean {
    try {
      return ctx.deps.env.fileOperator !== null;
    } catch {
      return false;
    }
  }

  /**
   * 列出目录内容。
   */
  async call(ctx: ToolRunContext, args: ToolArgs): Promise<Record<string, unknown>> {
    const parsed = ListDirArgsSchema.parse(args);
    const fileOperator = ctx.deps.env.fileOperator;
    if (fileOperator === null) {
      return { success: false, error: "file_operator not available." };
    }

    try {
      const entries = await fileOperator.listDir(parsed.path);
      return {
        path: parsed.path,
        entries,
        count: entries.length,
        success: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT") || message.includes("no such file")) {
        return { success: false, error: `Directory not found: ${parsed.path}` };
      }
      return { success: false, error: `Failed to list directory: ${message}` };
    }
  }
}
