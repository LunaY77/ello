import { defineTool, type AnyAgentTool } from '@ello/agent';
import { z } from 'zod';

import { createTaskService } from '../tasks/index.js';

import type { ApprovalFor } from './shared.js';

const TaskStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

const Metadata = z.record(z.string(), z.unknown()).default({});

/**
 * 任务工具集。
 *
 * 任务状态落到文件存储，CLI/TUI/模型工具共享同一份
 * TaskService，不再依赖单次 tool result 才能看见任务列表。
 */
export function createTaskTools(approval: ApprovalFor): AnyAgentTool[] {
  const service = createTaskService();

  return [
    defineTool({
      name: 'task_create',
      description: 'Create a persisted coding-agent task.',
      input: z.object({
        subject: z.string(),
        description: z.string().optional(),
        activeForm: z.string().optional(),
        owner: z.string().optional(),
        blocks: z.array(z.string()).optional(),
        blockedBy: z.array(z.string()).optional(),
        metadata: Metadata.optional(),
      }),
      approval: approval('task_create'),
      execute: (input) => service.create(input),
    }),
    defineTool({
      name: 'task_list',
      description: 'List persisted coding-agent tasks.',
      input: z.object({}),
      approval: approval('task_list'),
      execute: () => service.list(),
    }),
    defineTool({
      name: 'task_get',
      description: 'Get one persisted coding-agent task.',
      input: z.object({ id: z.string() }),
      approval: approval('task_get'),
      execute: async ({ id }) => {
        const task = await service.get(id);
        if (task === null) {
          throw new Error(`Unknown task: ${id}`);
        }
        return task;
      },
    }),
    defineTool({
      name: 'task_update',
      description: 'Update one persisted coding-agent task.',
      input: z.object({
        id: z.string(),
        subject: z.string().optional(),
        description: z.string().optional(),
        activeForm: z.string().nullable().optional(),
        status: TaskStatus.optional(),
        owner: z.string().nullable().optional(),
        blocks: z.array(z.string()).optional(),
        blockedBy: z.array(z.string()).optional(),
        metadata: Metadata.optional(),
      }),
      approval: approval('task_update'),
      execute: ({ id, ...input }) => service.update(id, input),
    }),
    defineTool({
      name: 'task_delete',
      description: 'Delete one persisted coding-agent task.',
      input: z.object({ id: z.string() }),
      approval: approval('task_delete'),
      execute: async ({ id }) => ({ deleted: await service.delete(id), id }),
    }),
    defineTool({
      name: 'task_claim',
      description: 'Claim a task for an owner and move it in progress.',
      input: z.object({ id: z.string(), owner: z.string() }),
      approval: approval('task_claim'),
      execute: ({ id, owner }) => service.claim(id, owner),
    }),
    defineTool({
      name: 'task_reset',
      description: 'Reset the current persisted task list.',
      input: z.object({}),
      approval: approval('task_reset'),
      execute: async () => {
        await service.reset();
        return { reset: true };
      },
    }),
  ] as AnyAgentTool[];
}
