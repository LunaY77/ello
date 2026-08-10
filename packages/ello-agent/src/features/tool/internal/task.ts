/**
 * 持久任务领域的 Command 定义。
 *
 * 简单任务操作使用 CLI invocation；包含嵌套 metadata 的创建和更新通过
 * `command_search` / `command_invoke` 使用 structured input。
 */
import { z } from 'zod';

import {
  cliInput,
  commandInput,
  defineCommand,
  structuredInput,
  type CommandDefinition,
} from '../../command/index.js';
import type { TaskService } from '../../task/index.js';
import type { ApprovalFor } from '../permissions/policy.js';

const TaskStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
const Metadata = z.record(z.string(), z.unknown()).default({});

/**
 * 创建绑定当前 TaskService 的任务 Command 集合。
 *
 * Args:
 * - `approval`: 当前 permission session 的审批回调工厂。
 * - `service`: 当前 task board 对应的领域服务。
 *
 * Returns:
 * - 返回可直接进入 Command Registry 的定义集合。
 */
export function createTaskCommands(
  approval: ApprovalFor,
  service: TaskService,
): CommandDefinition[] {
  const createInput = z
    .object({
      subject: z.string().describe('Task title'),
      description: z.string().optional().describe('Longer task description'),
      activeForm: z.string().optional().describe('Present-tense display form'),
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
    .strict();
  const updateInput = z
    .object({
      id: z.string().describe('Persisted task UUID or board sequence'),
      subject: z.string().optional().describe('Updated task title'),
      description: z.string().optional().describe('Updated task description'),
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
    .strict();
  const idInput = z
    .object({
      id: z.string().min(1).describe('Persisted task UUID or board sequence'),
    })
    .strict();
  const claimInput = z
    .object({
      id: z.string().min(1).describe('Persisted task UUID or board sequence'),
      owner: z.string().min(1).describe('Owner to assign'),
    })
    .strict();
  const emptyInput = z.object({}).strict();
  return [
    defineCommand({
      name: 'task_create',
      summary: 'Create a persisted coding-agent task.',
      aliases: ['new task'],
      risk: 'workspace-write',
      invocation: structuredInput(commandInput(createInput)),
      approval: approval('task_create'),
      execution: {
        kind: 'immediate',
        run: (input) => service.create(input),
      },
    }),
    defineCommand({
      name: 'task_list',
      summary: 'List persisted coding-agent tasks.',
      aliases: ['tasks'],
      risk: 'readonly',
      invocation: cliInput(commandInput(emptyInput)),
      effects: readonlyTaskCapabilities('task.list'),
      approval: approval('task_list'),
      execution: { kind: 'immediate', run: () => service.list() },
    }),
    defineCommand({
      name: 'task_get',
      summary:
        'Get one persisted task-board task. Subagent job ids belong to task_output and task_stop.',
      aliases: ['task details'],
      risk: 'readonly',
      invocation: cliInput(commandInput(idInput), {
        positionals: [{ field: 'id' }],
      }),
      effects: readonlyTaskCapabilities('task.get'),
      approval: approval('task_get'),
      execution: {
        kind: 'immediate',
        run: async ({ id }) => {
          assertPersistedTaskSelector(id);
          const task = await service.get(id);
          if (task === null) throw unknownPersistedTask(id);
          return task;
        },
      },
    }),
    defineCommand({
      name: 'task_update',
      summary: 'Update one persisted coding-agent task.',
      details:
        'Only the provided fields change; omitted fields keep their current value.',
      aliases: ['change task'],
      risk: 'workspace-write',
      invocation: structuredInput(commandInput(updateInput)),
      approval: approval('task_update'),
      execution: {
        kind: 'immediate',
        run: ({ id, ...input }) => {
          assertPersistedTaskSelector(id);
          return service.update(id, input);
        },
      },
    }),
    defineCommand({
      name: 'task_delete',
      summary: 'Delete one persisted coding-agent task.',
      aliases: ['remove task'],
      risk: 'workspace-write',
      invocation: cliInput(commandInput(idInput), {
        positionals: [{ field: 'id' }],
      }),
      approval: approval('task_delete'),
      execution: {
        kind: 'immediate',
        run: async ({ id }) => {
          assertPersistedTaskSelector(id);
          return {
            deleted: await service.delete(id),
            id,
          };
        },
      },
    }),
    defineCommand({
      name: 'task_claim',
      summary: 'Claim a task for an owner and move it in progress.',
      aliases: ['assign task'],
      risk: 'workspace-write',
      invocation: cliInput(commandInput(claimInput), {
        positionals: [{ field: 'id' }, { field: 'owner' }],
      }),
      approval: approval('task_claim'),
      execution: {
        kind: 'immediate',
        run: ({ id, owner }) => {
          assertPersistedTaskSelector(id);
          return service.claim(id, owner);
        },
      },
    }),
    defineCommand({
      name: 'task_reset',
      summary: 'Reset the current persisted task list.',
      aliases: ['clear tasks'],
      risk: 'workspace-write',
      invocation: cliInput(commandInput(emptyInput)),
      approval: approval('task_reset'),
      execution: {
        kind: 'immediate',
        run: async () => {
          await service.reset();
          return { reset: true };
        },
      },
    }),
  ];
}

function unknownPersistedTask(id: string): Error {
  const guidance = id.startsWith('job_')
    ? 'This is a subagent task ID; use task_output to read it or task_stop to stop it.'
    : 'Use task_list to find persisted task UUIDs or board sequences.';
  return new Error(`Unknown persisted task '${id}'. ${guidance}`);
}

function assertPersistedTaskSelector(id: string): void {
  if (id.startsWith('job_')) throw unknownPersistedTask(id);
}

function readonlyTaskCapabilities(telemetryTag: string) {
  return {
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    interruptible: true,
    telemetryTag,
  } as const;
}
