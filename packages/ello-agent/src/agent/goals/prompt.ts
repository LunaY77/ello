import { renderPromptTemplate } from '../context/prompts.js';
import type { AgentRunContext, SystemSection } from '../engine/index.js';

import type { GoalService } from './service.js';

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
