import { defineTool, type AnyAgentTool } from '@ello/agent';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config.js';

import type { ApprovalFor } from './shared.js';

/**
 * 任务工具：todo。
 *
 * 回写当前任务清单，结构化结果通过 `tool.completed` 事件流出，驱动 04 的 TUI
 * 任务面板和状态快照。只读语义 → `auto`，不打断。
 */
export function createTaskTools(
  _config: CodingAgentConfig,
  approval: ApprovalFor,
): AnyAgentTool[] {
  return [
    defineTool({
      name: 'todo',
      description:
        'Record the current task list for the TUI task panel and state snapshot.',
      input: z.object({
        items: z.array(
          z.object({
            title: z.string(),
            status: z.enum(['pending', 'in_progress', 'completed']),
          }),
        ),
      }),
      approval: approval('todo'),
      execute: ({ items }) => ({ items, updatedAt: new Date().toISOString() }),
    }),
  ];
}
