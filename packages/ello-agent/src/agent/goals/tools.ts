import { z } from 'zod';

import { defineTool, type AnyAgentTool } from '../engine/index.js';

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
