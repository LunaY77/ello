import { z } from "zod";
import { BaseTool, type ToolArgs, type ToolRunContext } from "../../base.js";

/** edit_file 工具输入 schema。 */
export const EditFileArgsSchema = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().default(false),
});

/**
 * 通过精确文本替换编辑文件。
 */
export class EditFileTool extends BaseTool {
  static override toolName = "edit_file";
  static override description =
    "Edit a file by replacing an exact string match. Use empty oldString to create a new file.";
  static override inputSchema = EditFileArgsSchema;

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
   * 执行精确替换。
   */
  async call(ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    const parsed = EditFileArgsSchema.parse(args);
    const fileOperator = ctx.deps.env.fileOperator;
    if (fileOperator === null) {
      return "Error: file_operator not available.";
    }

    if (!parsed.oldString) {
      try {
        await fileOperator.writeText(parsed.path, parsed.newString);
      } catch (error) {
        return `Error creating file: ${error instanceof Error ? error.message : String(error)}`;
      }
      return `Successfully created: ${parsed.path}`;
    }

    let content: string;
    try {
      content = await fileOperator.readText(parsed.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT") || message.includes("not found")) {
        return `Error: File not found: ${parsed.path}`;
      }
      return `Error: ${message}`;
    }

    if (!content.includes(parsed.oldString)) {
      return "Error: old_string not found in file. Ensure exact match including whitespace.";
    }

    if (!parsed.replaceAll) {
      const occurrences = countOccurrences(content, parsed.oldString);
      if (occurrences > 1) {
        return (
          `Error: old_string appears ${occurrences} times. ` +
          "Add more context to make it unique, or set replaceAll=true."
        );
      }
    }

    const nextContent = parsed.replaceAll
      ? content.split(parsed.oldString).join(parsed.newString)
      : content.replace(parsed.oldString, parsed.newString);

    try {
      await fileOperator.writeText(parsed.path, nextContent);
    } catch (error) {
      return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
    }

    return `Successfully edited: ${parsed.path}`;
  }
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return content.split(needle).length - 1;
}
