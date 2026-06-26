import { z } from 'zod';

import { BaseTool, type ToolArgs, type ToolRunContext } from '../../base.js';

/** web_search 工具输入 schema。 */
export const WebSearchArgsSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().positive().default(5),
});

/**
 * 通过搜索引擎 API 查询。
 */
export class WebSearchTool extends BaseTool {
  static override toolName = 'web_search';
  static override description =
    'Search the web using a search API. Requires SEARCH_API_KEY environment variable.';
  static override inputSchema = WebSearchArgsSchema;

  /**
   * 需要 fetch 和 SEARCH_API_KEY。
   */
  override isAvailable(): boolean {
    return (
      typeof globalThis.fetch === 'function' &&
      Boolean(process.env.SEARCH_API_KEY)
    );
  }

  /**
   * 执行搜索查询。
   */
  async call(_ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    const parsed = WebSearchArgsSchema.parse(args);
    const apiKey = process.env.SEARCH_API_KEY;
    if (!apiKey) {
      return 'Error: SEARCH_API_KEY not set.';
    }
    if (typeof globalThis.fetch !== 'function') {
      return 'Error: fetch not installed.';
    }

    const searchUrl =
      process.env.SEARCH_API_URL ??
      'https://api.search.brave.com/res/v1/web/search';

    let response: Response;
    try {
      response = await fetch(
        `${searchUrl}?q=${encodeURIComponent(parsed.query)}&count=${parsed.maxResults}`,
        {
          headers: {
            'X-Subscription-Token': apiKey,
            Accept: 'application/json',
          },
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      return `Error: Search failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title?: unknown;
          url?: unknown;
          description?: unknown;
        }>;
      };
    };
    const results = data.web?.results ?? [];
    if (!Array.isArray(results) || results.length === 0) {
      return 'No results found.';
    }

    return results
      .slice(0, parsed.maxResults)
      .map((result, index) => {
        const title = String(result.title ?? '');
        const url = String(result.url ?? '');
        const desc = String(result.description ?? '');
        return `${index + 1}. [${title}](${url})\n   ${desc}`;
      })
      .join('\n\n');
  }
}
