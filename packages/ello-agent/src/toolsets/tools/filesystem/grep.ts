import { z } from "zod";
import { BaseTool, type ToolArgs, type ToolRunContext } from "../../base.js";

/** 默认最大匹配结果数。 */
export const DEFAULT_GREP_MAX_RESULTS = 50;

/** grep 工具输入 schema。 */
export const GrepArgsSchema = z.object({
  pattern: z.string(),
  path: z.string().default("."),
  include: z.string().nullable().optional(),
  maxResults: z.number().int().positive().default(DEFAULT_GREP_MAX_RESULTS),
});

/**
 * 在文件中搜索文本/正则模式。
 */
export class GrepTool extends BaseTool {
  static override toolName = "grep";
  static override description =
    "Search for text or regex pattern in files. Prefers ripgrep (rg) if available, falls back to grep.";
  static override inputSchema = GrepArgsSchema;

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
   * 执行文本搜索。
   */
  async call(ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    const parsed = GrepArgsSchema.parse(args);
    const shell = ctx.deps.env.shell;
    if (shell === null) {
      return "Error: shell not available.";
    }

    const includeFlag = parsed.include ? `--glob ${shellQuote(parsed.include)}` : "";
    const rgCmd =
      `rg --line-number --no-heading --max-count ${parsed.maxResults} ` +
      `${includeFlag} -- ${shellQuote(parsed.pattern)} ${shellQuote(parsed.path)} 2>/dev/null`;
    let result = await shell.run(rgCmd, { timeout: 30_000 });
    if (result.exitCode === 0 || result.stdout.trim()) {
      return limitOutput(result.stdout.trim(), parsed.maxResults);
    }

    const grepIncludeFlag = parsed.include ? `--include=${shellQuote(parsed.include)}` : "";
    const grepCmd =
      `grep -rn ${grepIncludeFlag} -m ${parsed.maxResults} ` +
      `-- ${shellQuote(parsed.pattern)} ${shellQuote(parsed.path)} 2>/dev/null`;
    result = await shell.run(grepCmd, { timeout: 30_000 });
    const output = result.stdout.trim();
    return output || "No matches found.";
  }
}

function limitOutput(output: string, maxResults: number): string {
  if (!output) {
    return "No matches found.";
  }
  const lines = output.split(/\r?\n/);
  if (lines.length > maxResults) {
    return `${lines.slice(0, maxResults).join("\n")}\n... (${lines.length - maxResults} more)`;
  }
  return output;
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}
