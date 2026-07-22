/**
 * 本文件负责 thread feature 的工具定义与执行适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import { defineTool, type AnyAgentTool } from '../../agent/engine/index.js';

import type { GoalService } from './service.js';

export const UPDATE_GOAL_DESCRIPTION = `Update the active session goal.
Use this tool only when the current run includes an active ello goal controller. Never use it for an ordinary user request or merely because a task is complete.
Use it only to mark the active goal achieved or genuinely blocked.
Producing a final answer does not update the host goal state. If the objective is achieved, you must call this tool with status \`complete\` before returning the final answer.
Set status to \`complete\` only when the objective has actually been achieved and no required work remains.
Set status to \`blocked\` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked \`blocked\`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to \`blocked\` again.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to \`blocked\`.
Do not use \`blocked\` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.
When marking a budgeted goal achieved with status \`complete\`, report the final token usage from the tool result to the user.`;

/**
 * 构造 Thread 工具执行 模块 中的 `createGoalTools` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `service`: `createGoalTools` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 *
 * Throws:
 * - 当 Thread 工具执行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createGoalTools(service: GoalService): AnyAgentTool[] {
  return [
    defineTool({
      name: 'get_goal',
      description:
        'Get the current session goal, including status, usage, blocker audit, and remaining host limits.',
      discovery: { aliases: ['goal status'], risk: 'readonly' },
      input: z.object({}).strict(),
      execute: () => {
        const status = service.status();
        if (status === null || status.status !== 'active') {
          throw new Error('No active goal exists for this session.');
        }
        return status;
      },
    }),
    defineTool({
      name: 'update_goal',
      description: UPDATE_GOAL_DESCRIPTION,
      discovery: {
        aliases: ['complete goal', 'block goal'],
        risk: 'workspace-write',
      },
      input: z
        .object({
          status: z.enum(['complete', 'blocked']).describe('New goal status'),
          reason: z
            .string()
            .trim()
            .min(1)
            .describe('Reason for this status change'),
        })
        .strict(),
      execute: ({ status, reason }, context) =>
        service.update(status, reason, context.runId),
    }),
  ];
}
