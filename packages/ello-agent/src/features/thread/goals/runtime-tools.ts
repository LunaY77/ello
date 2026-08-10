/**
 * 本文件负责 thread feature 的“runtime-tools”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import type { Goal } from '../../../protocol/v1/index.js';
import type { SystemSection } from '../../agent/engine/index.js';
import {
  cliInput,
  commandInput,
  defineCommand,
  defineCommandModule,
  type CommandModule,
} from '../../command/index.js';

export interface ThreadGoalToolResult {
  readonly kind: 'thread-goal-updated';
  readonly goal: Goal;
  readonly message: string;
}

export interface ThreadGoalRuntime {
  readonly module: CommandModule;
  readonly systemSection: SystemSection;
}

/**
 * 把 App Server 的稳定 Goal 协议接入单个 Turn，运行状态只由当前闭包持有。
 *
 * Args:
 * - `initialGoal`: `createThreadGoalRuntime` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createThreadGoalRuntime` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Thread `runtime-tools` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createThreadGoalRuntime(
  initialGoal: Goal | null,
): ThreadGoalRuntime {
  if (initialGoal === null || initialGoal.status !== 'active') {
    return {
      module: defineCommandModule({ id: 'goal', commands: [] }),
      systemSection: () => null,
    };
  }
  let currentGoal = initialGoal;
  return {
    systemSection: () => renderGoalSection(currentGoal),
    module: defineCommandModule({
      id: 'goal',
      commands: [
        defineCommand({
          name: 'get_goal',
          summary:
            'Get the current thread goal and its persisted token usage. Fails when this thread has no goal.',
          aliases: ['goal status'],
          risk: 'readonly',
          effects: () => ({
            concurrencySafe: true,
            readOnly: true,
            destructive: false,
            telemetryTag: 'goal.get',
          }),
          invocation: cliInput(commandInput(z.object({}).strict())),
          execution: {
            kind: 'immediate',
            run: () => {
              if (currentGoal === null) {
                throw new Error('No goal exists for this thread.');
              }
              return goalView(currentGoal);
            },
          },
        }),
        defineCommand({
          name: 'update_goal',
          summary:
            'Mark the active thread goal complete or blocked. This updates the persisted host goal; ordinary final text does not.',
          aliases: ['complete goal', 'block goal'],
          risk: 'workspace-write',
          invocation: cliInput(
            commandInput(
              z
                .object({
                  status: z
                    .enum(['complete', 'blocked'])
                    .describe('New goal status'),
                })
                .strict(),
            ),
            {
              positionals: [{ field: 'status' }],
            },
          ),
          execution: {
            kind: 'immediate',
            run: ({ status }): ThreadGoalToolResult => {
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
          },
        }),
      ],
    }),
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
