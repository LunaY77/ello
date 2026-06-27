import { z } from 'zod';

import { defineTool } from '../public/tool.js';
import type { AgentTool } from '../public/types.js';

/**
 * 创建网络工具。
 *
 * Returns:
 *   包含 web_fetch 的 AgentTool[]。网络工具默认要求审批。
 */
export function createWebTools(): AgentTool<any, unknown>[] {
  return [
    defineTool({
      name: 'web_fetch',
      description: 'Fetch text content from a URL.',
      input: z.object({
        url: z.string().url(),
        maxLength: z.number().int().positive().default(8000),
      }),
      approval: () => 'required',
      execute: async ({ url, maxLength }) => {
        const response = await fetch(url);
        const text = await response.text();
        return text.slice(0, maxLength);
      },
    }),
  ];
}
