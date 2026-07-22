/**
 * 本文件负责 tool feature 的“task”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import { defineAnyTool, type AnyAgentTool } from '../../agent/engine/index.js';
import type { TaskService } from '../../task/index.js';
import type { ApprovalFor } from '../permissions/policy.js';

const TaskStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

const Metadata = z.record(z.string(), z.unknown()).default({});

/**
 * 任务工具集。
 *
 * CLI/TUI/模型工具共享绑定当前 board 的 TaskService。
 *
 * Args:
 * - `approval`: `createTaskTools` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `service`: `createTaskTools` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 *
 * Throws:
 * - 当 工具 `task` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createTaskTools(
  approval: ApprovalFor,
  service: TaskService,
): AnyAgentTool[] {
  return [
    defineAnyTool({
      name: 'task_create',
      description: 'Create a persisted coding-agent task.',
      discovery: { aliases: ['new task'], risk: 'workspace-write' },
      input: z
        .object({
          subject: z.string().describe('Task title'),
          description: z
            .string()
            .optional()
            .describe('Longer task description'),
          activeForm: z
            .string()
            .optional()
            .describe('Present-tense form for display'),
          owner: z.string().optional().describe('Task owner identifier'),
          blocks: z
            .array(z.string())
            .optional()
            .describe('Task IDs this task blocks'),
          blockedBy: z
            .array(z.string())
            .optional()
            .describe('Task IDs that block this task'),
          metadata: Metadata.optional().describe('Additional structured data'),
        })
        .strict(),
      approval: approval('task_create'),
      execute: (input) => service.create(input),
    }),
    defineAnyTool({
      name: 'task_list',
      description: 'List persisted coding-agent tasks.',
      discovery: { aliases: ['tasks'], risk: 'readonly' },
      input: z.object({}).strict(),
      approval: approval('task_list'),
      execute: () => service.list(),
    }),
    defineAnyTool({
      name: 'task_get',
      description: 'Get one persisted coding-agent task.',
      discovery: { aliases: ['task details'], risk: 'readonly' },
      input: z.object({ id: z.string().describe('Task identifier') }).strict(),
      approval: approval('task_get'),
      execute: async ({ id }) => {
        const task = await service.get(id);
        if (task === null) {
          throw new Error(`Unknown task: ${id}`);
        }
        return task;
      },
    }),
    defineAnyTool({
      name: 'task_update',
      description: 'Update one persisted coding-agent task.',
      discovery: { aliases: ['change task'], risk: 'workspace-write' },
      input: z
        .object({
          id: z.string().describe('Task identifier'),
          subject: z.string().optional().describe('Updated task title'),
          description: z
            .string()
            .optional()
            .describe('Updated task description'),
          activeForm: z
            .string()
            .nullable()
            .optional()
            .describe('Updated present-tense form'),
          status: TaskStatus.optional().describe('New task status'),
          owner: z
            .string()
            .nullable()
            .optional()
            .describe('Updated owner identifier'),
          blocks: z
            .array(z.string())
            .optional()
            .describe('Updated blocked task IDs'),
          blockedBy: z
            .array(z.string())
            .optional()
            .describe('Updated blocking task IDs'),
          metadata: Metadata.optional().describe('Updated structured data'),
        })
        .strict(),
      approval: approval('task_update'),
      execute: ({ id, ...input }) => service.update(id, input),
    }),
    defineAnyTool({
      name: 'task_delete',
      description: 'Delete one persisted coding-agent task.',
      discovery: { aliases: ['remove task'], risk: 'workspace-write' },
      input: z.object({ id: z.string().describe('Task identifier') }).strict(),
      approval: approval('task_delete'),
      execute: async ({ id }) => ({ deleted: await service.delete(id), id }),
    }),
    defineAnyTool({
      name: 'task_claim',
      description: 'Claim a task for an owner and move it in progress.',
      discovery: { aliases: ['assign task'], risk: 'workspace-write' },
      input: z
        .object({
          id: z.string().describe('Task identifier'),
          owner: z.string().describe('Owner to assign'),
        })
        .strict(),
      approval: approval('task_claim'),
      execute: ({ id, owner }) => service.claim(id, owner),
    }),
    defineAnyTool({
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
  ];
}
