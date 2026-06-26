import { z } from "zod";
import { BaseTool, type ToolArgs, type ToolRunContext } from "../../base.js";

/** 默认最大搜索结果数。 */
export const DEFAULT_GLOB_MAX_RESULTS = 200;

/** glob 工具输入 schema。 */
export const GlobArgsSchema = z.object({
  pattern: z.string(),
  root: z.string().default("."),
  maxResults: z.number().int().positive().default(DEFAULT_GLOB_MAX_RESULTS),
});

/**
 * 通过 glob pattern 搜索文件。
 */
export class GlobTool extends BaseTool {
  static override toolName = "glob";
  static override description = "Find files matching a glob pattern. Returns matching file paths.";
  static override inputSchema = GlobArgsSchema;

  /**
   * 需要 shell 来执行 find 命令。
   */
  override isAvailable(ctx: ToolRunContext): boolean {
    try {
      return ctx.deps.env.shell !== null;
    } catch {
      return false;
    }
  }

  /**
   * 搜索匹配 pattern 的文件。
   */
  async call(ctx: ToolRunContext, args: ToolArgs): Promise<string[] | Record<string, unknown>> {
    const parsed = GlobArgsSchema.parse(args);
    const shell = ctx.deps.env.shell;
    if (shell === null) {
      return { error: "shell not available" };
    }

    const result = await shell.run(
      `find ${shellQuote(parsed.root)} -path ${shellQuote(parsed.pattern)} -type f 2>/dev/null | head -n ${parsed.maxResults + 1}`,
      { timeout: 30_000 },
    );

    if (result.exitCode !== 0 && !result.stdout) {
      return [];
    }

    const files = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (files.length > parsed.maxResults) {
      return {
        files: files.slice(0, parsed.maxResults),
        truncated: true,
        note: `Showing ${parsed.maxResults} of ${files.length}+ matches.`,
      };
    }
    return files;
  }
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}
