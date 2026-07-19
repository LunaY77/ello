import { z } from 'zod';

import type { TaskService } from '../../storage/tasks/index.js';
import { defineTool, type AnyAgentTool } from '../engine/index.js';

import type { ApprovalFor } from './shared.js';

const TaskStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

const Metadata = z.record(z.string(), z.unknown()).default({});

/**
 * 任务工具集。
 *
 * CLI/TUI/模型工具共享绑定当前 board 的 TaskService。
 */
export function createTaskTools(
  approval: ApprovalFor,
  service: TaskService,
): AnyAgentTool[] {
  return [
    defineTool({
      name: 'task_create',
      description: 'Create a persisted coding-agent task.',
      discovery: { aliases: ['new task'], risk: 'workspace-write' },
      input: z
        .object({
          subject: z.string(),
          description: z.string().optional(),
          activeForm: z.string().optional(),
          owner: z.string().optional(),
          blocks: z.array(z.string()).optional(),
          blockedBy: z.array(z.string()).optional(),
          metadata: Metadata.optional(),
        })
        .strict(),
      approval: approval('task_create'),
      execute: (input) => service.create(input),
    }),
    defineTool({
      name: 'task_list',
      description: 'List persisted coding-agent tasks.',
      discovery: { aliases: ['tasks'], risk: 'readonly' },
      input: z.object({}).strict(),
      approval: approval('task_list'),
      execute: () => service.list(),
    }),
    defineTool({
      name: 'task_get',
      description: 'Get one persisted coding-agent task.',
      discovery: { aliases: ['task details'], risk: 'readonly' },
      input: z.object({ id: z.string() }).strict(),
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
      discovery: { aliases: ['change task'], risk: 'workspace-write' },
      input: z
        .object({
          id: z.string(),
          subject: z.string().optional(),
          description: z.string().optional(),
          activeForm: z.string().nullable().optional(),
          status: TaskStatus.optional(),
          owner: z.string().nullable().optional(),
          blocks: z.array(z.string()).optional(),
          blockedBy: z.array(z.string()).optional(),
          metadata: Metadata.optional(),
        })
        .strict(),
      approval: approval('task_update'),
      execute: ({ id, ...input }) => service.update(id, input),
    }),
    defineTool({
      name: 'task_delete',
      description: 'Delete one persisted coding-agent task.',
      discovery: { aliases: ['remove task'], risk: 'workspace-write' },
      input: z.object({ id: z.string() }).strict(),
      approval: approval('task_delete'),
      execute: async ({ id }) => ({ deleted: await service.delete(id), id }),
    }),
    defineTool({
      name: 'task_claim',
      description: 'Claim a task for an owner and move it in progress.',
      discovery: { aliases: ['assign task'], risk: 'workspace-write' },
      input: z.object({ id: z.string(), owner: z.string() }).strict(),
      approval: approval('task_claim'),
      execute: ({ id, owner }) => service.claim(id, owner),
    }),
    defineTool({
      name: 'task_reset',
      description: 'Reset the current persisted task list.',
      discovery: { aliases: ['clear tasks'], risk: 'workspace-write' },
      input: z.object({}).strict(),
      approval: approval('task_reset'),
      execute: async () => {
        await service.reset();
        return { reset: true };
      },
    }),
  ] as AnyAgentTool[];
}
