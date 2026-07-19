import { createHash, randomUUID } from 'node:crypto';

import type { AgentUsage } from '../engine/index.js';

import {
  billableGoalTokens,
  type GoalPauseReason,
  type GoalState,
  type GoalStatusView,
  type GoalUpdateResult,
} from './types.js';

export interface GoalPersistencePort {
  load(): Promise<GoalState | null>;
  save(goal: GoalState): Promise<void>;
  clear(goalId: string): Promise<void>;
}

export interface GoalServiceOptions {
  readonly port: GoalPersistencePort;
  readonly maxContinuations: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly onChanged?: (goal: GoalState, previous: GoalState | null) => void;
  readonly onCleared?: (goalId: string) => void;
}

export class GoalService {
  private goal: GoalState | null = null;
  private lastBlockerRunId: string | null = null;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: GoalServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async load(): Promise<GoalState | null> {
    this.goal = await this.options.port.load();
    this.lastBlockerRunId = null;
    return this.goal;
  }

  current(): GoalState | null {
    return this.goal;
  }

  active(): GoalState | null {
    return this.goal?.status === 'active' ? this.goal : null;
  }

  status(): GoalStatusView | null {
    const goal = this.goal;
    if (goal === null) return null;
    const activeElapsedMs =
      goal.status === 'active'
        ? elapsedActiveMs(goal, this.now())
        : goal.activeMs;
    return {
      ...goal,
      ...(goal.tokenBudget !== undefined
        ? {
            remainingTokens: Math.max(0, goal.tokenBudget - goal.tokensUsed),
          }
        : {}),
      remainingContinuations: Math.max(
        0,
        this.options.maxContinuations - goal.continuationTurns,
      ),
      activeElapsedMs,
    };
  }

  async create(objective: string, tokenBudget?: number): Promise<GoalState> {
    const normalized = objective.trim();
    if (normalized === '') throw new Error('Goal objective must not be empty.');
    if (normalized.length > 4000) {
      throw new Error('Goal objective must not exceed 4000 characters.');
    }
    if (
      tokenBudget !== undefined &&
      (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
    ) {
      throw new Error('Goal token budget must be a positive integer.');
    }
    if (this.goal?.status === 'active' || this.goal?.status === 'paused') {
      throw new Error(
        'An active or paused goal already exists. Clear or complete it first.',
      );
    }
    const timestamp = this.now().toISOString();
    const goal: GoalState = {
      id: this.createId(),
      objective: normalized,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      continuationTurns: 0,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      tokensUsed: 0,
      activeMs: 0,
      activeSince: timestamp,
      blockerStreak: 0,
    };
    await this.persist(goal);
    return goal;
  }

  async pause(reason: GoalPauseReason = 'user'): Promise<GoalState> {
    const goal = this.requireStatus('active');
    const timestamp = this.now();
    const next: GoalState = {
      ...goal,
      status: 'paused',
      updatedAt: timestamp.toISOString(),
      activeMs: elapsedActiveMs(goal, timestamp),
      pauseReason: reason,
    };
    deleteMutable(next, 'activeSince');
    await this.persist(next);
    return next;
  }

  async resume(): Promise<GoalState> {
    const goal = this.requireStatus('paused');
    if (goal.pauseReason === 'token_budget') {
      throw new Error(
        'Token budget is exhausted. Clear this goal and create a new goal with an explicit budget.',
      );
    }
    if (goal.pauseReason === 'continuation_limit') {
      throw new Error(
        'Continuation limit is exhausted. Clear this goal before creating a new goal.',
      );
    }
    const timestamp = this.now().toISOString();
    const next: GoalState = {
      ...goal,
      status: 'active',
      updatedAt: timestamp,
      activeSince: timestamp,
      blockerStreak: 0,
    };
    deleteMutable(next, 'pauseReason');
    deleteMutable(next, 'blockerReason');
    deleteMutable(next, 'blockerFingerprint');
    await this.persist(next);
    return next;
  }

  async clear(): Promise<string> {
    const goal = this.goal;
    if (
      goal === null ||
      (goal.status !== 'active' && goal.status !== 'paused')
    ) {
      throw new Error('No active or paused goal to clear.');
    }
    await this.options.port.clear(goal.id);
    this.goal = null;
    this.options.onCleared?.(goal.id);
    return goal.id;
  }

  async beginContinuation(): Promise<GoalState> {
    const goal = this.requireStatus('active');
    if (goal.continuationTurns >= this.options.maxContinuations) {
      return this.pause('continuation_limit');
    }
    const next: GoalState = {
      ...goal,
      continuationTurns: goal.continuationTurns + 1,
      updatedAt: this.now().toISOString(),
    };
    await this.persist(next);
    return next;
  }

  async recordUsage(
    goalId: string,
    usage: AgentUsage,
  ): Promise<GoalState | null> {
    const goal = this.goal;
    if (goal === null || goal.id !== goalId) return null;
    const timestamp = this.now();
    let next: GoalState = {
      ...goal,
      tokensUsed: goal.tokensUsed + billableGoalTokens(usage),
      updatedAt: timestamp.toISOString(),
      ...(goal.status === 'active'
        ? {
            activeMs: elapsedActiveMs(goal, timestamp),
            activeSince: timestamp.toISOString(),
          }
        : {}),
    };
    if (
      next.status === 'active' &&
      next.tokenBudget !== undefined &&
      next.tokensUsed >= next.tokenBudget
    ) {
      next = withoutActiveSince({
        ...next,
        status: 'paused',
        pauseReason: 'token_budget',
      });
    } else if (
      next.status === 'active' &&
      next.continuationTurns >= this.options.maxContinuations
    ) {
      next = withoutActiveSince({
        ...next,
        status: 'paused',
        pauseReason: 'continuation_limit',
      });
    }
    await this.persist(next);
    return next;
  }

  async update(
    status: 'complete' | 'blocked',
    reason: string,
    runId?: string,
  ): Promise<GoalUpdateResult> {
    const goal = this.requireStatus('active');
    const normalizedReason = normalizeReason(reason);
    if (status === 'complete') {
      const timestamp = this.now();
      const completed = withoutActiveSince({
        ...goal,
        status: 'complete',
        updatedAt: timestamp.toISOString(),
        activeMs: elapsedActiveMs(goal, timestamp),
        completionReason: normalizedReason,
        completedAt: timestamp.toISOString(),
      });
      await this.persist(completed);
      return {
        goal: completed,
        applied: true,
        message:
          completed.tokenBudget === undefined
            ? 'Goal marked complete.'
            : `Goal marked complete. Final token usage: ${completed.tokensUsed}/${completed.tokenBudget}.`,
      };
    }
    if (runId !== undefined && runId === this.lastBlockerRunId) {
      return {
        goal,
        applied: false,
        message: `Blocked audit already recorded for run ${runId}. Goal remains active.`,
      };
    }
    const fingerprint = createHash('sha256')
      .update(normalizedReason.toLowerCase())
      .digest('hex');
    const blockerStreak =
      goal.blockerFingerprint === fingerprint ? goal.blockerStreak + 1 : 1;
    const timestamp = this.now();
    this.lastBlockerRunId = runId ?? null;
    if (blockerStreak < 3) {
      const pending: GoalState = {
        ...goal,
        updatedAt: timestamp.toISOString(),
        blockerReason: normalizedReason,
        blockerFingerprint: fingerprint,
        blockerStreak,
      };
      await this.persist(pending);
      return {
        goal: pending,
        applied: false,
        message: `Blocked audit pending (${blockerStreak}/3). Goal remains active.`,
      };
    }
    const blocked = withoutActiveSince({
      ...goal,
      status: 'blocked',
      updatedAt: timestamp.toISOString(),
      activeMs: elapsedActiveMs(goal, timestamp),
      blockerReason: normalizedReason,
      blockerFingerprint: fingerprint,
      blockerStreak,
    });
    await this.persist(blocked);
    return { goal: blocked, applied: true, message: 'Goal marked blocked.' };
  }

  private requireStatus(status: GoalState['status']): GoalState {
    if (this.goal === null) throw new Error('No goal exists for this session.');
    if (this.goal.status !== status) {
      throw new Error(
        `Goal must be ${status}; current status is ${this.goal.status}.`,
      );
    }
    return this.goal;
  }

  private async persist(goal: GoalState): Promise<void> {
    const previous = this.goal;
    await this.options.port.save(goal);
    this.goal = goal;
    this.options.onChanged?.(goal, previous);
  }
}

function elapsedActiveMs(goal: GoalState, now: Date): number {
  if (goal.activeSince === undefined) {
    throw new Error(`Active goal ${goal.id} is missing activeSince.`);
  }
  return (
    goal.activeMs + Math.max(0, now.getTime() - Date.parse(goal.activeSince))
  );
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim().replace(/\s+/gu, ' ');
  if (normalized === '')
    throw new Error('Goal update reason must not be empty.');
  return normalized;
}

function withoutActiveSince<T extends GoalState>(goal: T): T {
  deleteMutable(goal, 'activeSince');
  return goal;
}

function deleteMutable<T extends object, K extends keyof T>(
  value: T,
  key: K,
): void {
  delete (value as { -readonly [P in keyof T]?: T[P] })[key];
}
