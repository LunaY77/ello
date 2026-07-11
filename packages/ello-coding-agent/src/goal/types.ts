import type { AgentUsage } from '@ello/agent';

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export type GoalPauseReason = 'user' | 'token_budget' | 'continuation_limit';

export interface GoalState {
  readonly id: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly continuationTurns: number;
  readonly tokenBudget?: number;
  readonly tokensUsed: number;
  readonly activeMs: number;
  readonly activeSince?: string;
  readonly blockerReason?: string;
  readonly blockerFingerprint?: string;
  readonly blockerStreak: number;
  readonly pauseReason?: GoalPauseReason;
  readonly completionReason?: string;
  readonly completedAt?: string;
}

export interface GoalStatusView extends GoalState {
  readonly remainingTokens?: number;
  readonly remainingContinuations: number;
  readonly activeElapsedMs: number;
}

export interface GoalUpdateResult {
  readonly goal: GoalState;
  readonly applied: boolean;
  readonly message: string;
}

export function billableGoalTokens(usage: AgentUsage): number {
  return (
    Math.max(0, usage.inputTokens - usage.cacheReadTokens) + usage.outputTokens
  );
}
