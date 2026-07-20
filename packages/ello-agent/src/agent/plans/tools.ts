import { z } from 'zod';

import { defineTool, type AgentTool } from '../engine/index.js';

/**
 * Plan 模式专用内部工具。
 *
 * 工具本身不接触文件和 Thread 状态，只把模型意图交回 Turn 执行器；Server 会再次校验
 * 当前模式、Thread 归属和 Plan 状态，避免工具成为绕过权限引擎的写入旁路。
 */
export function createPlanTools(input: {
  readonly write: (content: string) => Promise<string>;
  readonly requestExit: () => Promise<string>;
}): readonly AgentTool[] {
  return [
    defineTool({
      name: 'write_plan',
      description:
        'Write the complete Markdown implementation plan for the current plan session. This is the only writable artifact in Plan mode.',
      discovery: { aliases: ['save plan'], risk: 'workspace-write' },
      input: z
        .object({
          content: z.string().min(1).describe('Markdown plan content'),
        })
        .strict(),
      execute: ({ content }) => input.write(content),
    }),
    defineTool({
      name: 'request_plan_exit',
      description:
        'Validate the current plan and request user approval after investigation and planning are complete.',
      discovery: { aliases: ['approve plan'], risk: 'workspace-write' },
      input: z.object({}).strict(),
      execute: () => input.requestExit(),
    }),
  ];
}
