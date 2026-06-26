import { z } from "zod";
import { BaseTool, type ToolArgs, type ToolRunContext } from "../../base.js";

/** web_fetch 工具输入 schema。 */
export const WebFetchArgsSchema = z.object({
  url: z.string(),
  maxLength: z.number().int().positive().default(50_000),
});

/** 最大抓取内容长度。 */
export const MAX_CONTENT_LENGTH = 50_000;

/**
 * 抓取 URL 内容并转为文本。
 */
export class WebFetchTool extends BaseTool {
  static override toolName = "web_fetch";
  static override description = "Fetch a URL and return content as markdown. Requires built-in fetch.";
  static override inputSchema = WebFetchArgsSchema;

  /**
   * 检查 fetch 是否可用。
   */
  override isAvailable(): boolean {
    return typeof globalThis.fetch === "function";
  }

  /**
   * 抓取 URL 内容。
   */
  async call(_ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    const parsed = WebFetchArgsSchema.parse(args);
    if (typeof globalThis.fetch !== "function") {
      return "Error: fetch not installed.";
    }

    let response: Response;
    try {
      response = await fetch(parsed.url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      return `Error fetching URL: ${error instanceof Error ? error.message : String(error)}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    let text = await response.text();
    if (contentType.includes("text/html")) {
      text = stripHtml(text);
    }

    if (text.length > parsed.maxLength) {
      text = `${text.slice(0, parsed.maxLength)}\n\n[... truncated, total ${text.length} chars]`;
    }
    return text;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<img[\s\S]*?>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
