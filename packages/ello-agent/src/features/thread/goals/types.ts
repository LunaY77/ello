/**
 * 本文件负责 thread feature 的领域类型与闭合联合。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { AgentUsage } from '../../agent/engine/index.js';

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

/**
 * 执行 Thread `types` 模块 定义的 `billableGoalTokens` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `usage`: `billableGoalTokens` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `billableGoalTokens` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function billableGoalTokens(usage: AgentUsage): number {
  return (
    Math.max(0, usage.inputTokens - usage.cacheReadTokens) + usage.outputTokens
  );
}
