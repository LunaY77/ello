import { z } from "zod";
import { BaseTool, type ToolArgs, type ToolRunContext } from "../base.js";

/** write_file 工具输入 schema。 */
export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

/**
 * 写入文本文件, 父目录不存在时自动创建。
 */
export class WriteFileTool extends BaseTool {
  static override toolName = "write_file";
  static override description = "Write text content to a file. Creates parent directories if needed.";
  static override inputSchema = WriteFileArgsSchema;

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
   * 写入文件。
   */
  async call(ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    const parsed = WriteFileArgsSchema.parse(args);
    const fileOperator = ctx.deps.env.fileOperator;
    if (fileOperator === null) {
      return "Error: file_operator not available.";
    }

    try {
      await fileOperator.writeText(parsed.path, parsed.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error writing file: ${message}`;
    }

    return `Successfully wrote to ${parsed.path}`;
  }
}
