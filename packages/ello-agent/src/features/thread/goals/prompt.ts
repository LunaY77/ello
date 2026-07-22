/**
 * 本文件负责 thread feature 的“prompt”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  AgentRunContext,
  SystemSection,
} from '../../agent/engine/index.js';
import { renderPromptTemplate } from '../../agent/index.js';

import type { GoalService } from './service.js';

/**
 * 构造 Thread `prompt` 模块 中的 `createGoalSystemSection` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `service`: `createGoalSystemSection` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createGoalSystemSection` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Thread `prompt` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createGoalSystemSection(service: GoalService): SystemSection {
  return (run: AgentRunContext) => {
    const goal = service.current();
    if (goal === null || run.metadata.goalId !== goal.id) return null;
    if (run.metadata.goalInitial === true) {
      return renderPromptTemplate('goal-activated', {
        objective: goal.objective,
      });
    }
    if (run.metadata.goalContinuation !== true) return null;
    const remainingTokens =
      goal.tokenBudget === undefined
        ? 'unlimited'
        : Math.max(0, goal.tokenBudget - goal.tokensUsed);
    return renderPromptTemplate('goal-continuation', {
      objective: goal.objective,
      tokens_used: goal.tokensUsed,
      token_budget: goal.tokenBudget ?? 'none',
      remaining_tokens: remainingTokens,
      continuation_turns: goal.continuationTurns,
      blocker_streak: goal.blockerStreak,
    });
  };
}
