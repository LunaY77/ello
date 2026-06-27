import { z } from 'zod';

import { defineTool } from '../public/tool.js';
import type { AgentTool } from '../public/types.js';

/**
 * 创建工具搜索工具。
 *
 * Args:
 *   tools: 可被搜索的工具列表。
 *
 * Returns:
 *   包含 tool_search 的 AgentTool[]，返回命中的工具名和描述。
 */
export function createToolSearchTools(
  tools: readonly AgentTool<any, unknown>[],
): AgentTool<any, unknown>[] {
  return [
    defineTool({
      name: 'tool_search',
      description: 'Search available tools by keyword.',
      input: z.object({
        query: z.string(),
        maxResults: z.number().int().positive().default(10),
      }),
      execute: ({ query, maxResults }) => {
        const normalized = query.toLowerCase();
        return tools
          .filter(
            (tool) =>
              tool.name.toLowerCase().includes(normalized) ||
              tool.description.toLowerCase().includes(normalized),
          )
          .slice(0, maxResults)
          .map((tool) => ({ name: tool.name, description: tool.description }));
      },
    }),
  ];
}
