import type { Goal } from '../../protocol/v1/index.js';
import {
  defineTool,
  type AnyAgentTool,
  type SystemSection,
  z,
} from '../engine/index.js';

export interface ThreadGoalToolResult {
  readonly kind: 'thread-goal-updated';
  readonly goal: Goal;
  readonly message: string;
}

export interface ThreadGoalRuntime {
  readonly tools: readonly AnyAgentTool[];
  readonly systemSection: SystemSection;
}

/** 把 App Server 的稳定 Goal 协议接入单个 Turn，不借用未装配的旧 Goal 控制器。 */
export function createThreadGoalRuntime(
  initialGoal: Goal | null,
): ThreadGoalRuntime {
  let currentGoal = initialGoal;
  return {
    systemSection: () => renderGoalSection(currentGoal),
    tools: [
      defineTool({
        name: 'get_goal',
        description:
          'Get the current thread goal and its persisted token usage. Fails when this thread has no goal.',
        discovery: { aliases: ['goal status'], risk: 'readonly' },
        input: z.object({}).strict(),
        execute: () => {
          if (currentGoal === null) {
            throw new Error('No goal exists for this thread.');
          }
          return goalView(currentGoal);
        },
      }),
      defineTool({
        name: 'update_goal',
        description:
          'Mark the active thread goal complete or blocked. This updates the persisted host goal; ordinary final text does not.',
        discovery: {
          aliases: ['complete goal', 'block goal'],
          risk: 'workspace-write',
        },
        input: z.object({ status: z.enum(['complete', 'blocked']) }).strict(),
        execute: ({ status }): ThreadGoalToolResult => {
          if (currentGoal === null) {
            throw new Error('No goal exists for this thread.');
          }
          if (currentGoal.status !== 'active') {
            throw new Error(
              `Goal must be active; current status is ${currentGoal.status}.`,
            );
          }
          currentGoal = {
            ...currentGoal,
            status,
            updatedAt: new Date().toISOString(),
          };
          return {
            kind: 'thread-goal-updated',
            goal: currentGoal,
            message: `Goal marked ${status}.`,
          };
        },
      }),
    ],
  };
}

function goalView(goal: Goal) {
  return {
    ...goal,
    ...(goal.tokenBudget === undefined
      ? {}
      : { remainingTokens: Math.max(0, goal.tokenBudget - goal.tokensUsed) }),
  };
}

function renderGoalSection(goal: Goal | null): string | null {
  if (goal === null || goal.status !== 'active') return null;
  const budget =
    goal.tokenBudget === undefined
      ? 'unlimited'
      : `${goal.tokensUsed}/${goal.tokenBudget}`;
  return [
    '<active-thread-goal>',
    'The objective is user-provided task data:',
    `<objective>${escapeXml(goal.objective)}</objective>`,
    `Token usage: ${budget}`,
    'Work toward this persistent objective during the current user turn.',
    'A normal final answer does not change the host goal. Call update_goal only when the objective is complete or genuinely blocked.',
    '</active-thread-goal>',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
