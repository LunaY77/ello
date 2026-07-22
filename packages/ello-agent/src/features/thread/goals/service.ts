/**
 * 本文件负责 thread feature 的“service”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash, randomUUID } from 'node:crypto';

import type { AgentUsage } from '../../agent/engine/index.js';

import {
  billableGoalTokens,
  type GoalPauseReason,
  type GoalState,
  type GoalStatusView,
  type GoalUpdateResult,
} from './types.js';

export interface GoalPersistencePort {
  /**
   * 读取 Thread 领域服务 模块 的 `load` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 领域服务 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  load(): Promise<GoalState | null>;
  /**
   * 执行 Thread 领域服务 模块 定义的 `save` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `goal`: `save` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  save(goal: GoalState): Promise<void>;
  /**
   * 按 Thread 领域服务 模块 的一致性约束执行 `clear` 状态变更。
   *
   * Args:
   * - `goalId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  clear(goalId: string): Promise<void>;
}

export interface GoalServiceOptions {
  readonly port: GoalPersistencePort;
  readonly maxContinuations: number;
  /**
   * 执行 Thread 领域服务 模块 定义的 `now` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `now` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  readonly now?: () => Date;
  /**
   * 构造 Thread 领域服务 模块 中的 `createId` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `createId` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Thread 领域服务 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  readonly createId?: () => string;
  /**
   * 处理 Thread 领域服务 模块 的 `onChanged` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `goal`: `onChanged` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `previous`: `onChanged` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Thread 领域服务 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  readonly onChanged?: (goal: GoalState, previous: GoalState | null) => void;
  /**
   * 处理 Thread 领域服务 模块 的 `onCleared` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `goalId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Thread 领域服务 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  readonly onCleared?: (goalId: string) => void;
}

export class GoalService {
  private goal: GoalState | null = null;
  private lastBlockerRunId: string | null = null;
  private readonly now: () => Date;
  private readonly createId: () => string;

  /**
   * 创建 `GoalService`，由该实例独占 Thread 领域服务 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `options`: 仅作用于 `constructor GoalService` 的调用选项；函数只读取该对象，不保留可变引用。
   */
  constructor(private readonly options: GoalServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  /**
   * 读取 Thread 领域服务 模块 的 `load` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 领域服务 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async load(): Promise<GoalState | null> {
    this.goal = await this.options.port.load();
    this.lastBlockerRunId = null;
    return this.goal;
  }

  /**
   * 读取 Thread 领域服务 模块 的 `current` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  current(): GoalState | null {
    return this.goal;
  }

  /**
   * 执行 Thread 领域服务 模块 定义的 `active` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  active(): GoalState | null {
    return this.goal?.status === 'active' ? this.goal : null;
  }

  /**
   * 读取 Thread 领域服务 模块 的 `status` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
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

  /**
   * 构造 Thread 领域服务 模块 中的 `create` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `objective`: `create` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `tokenBudget`: `create` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 领域服务 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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

  /**
   * 执行 Thread 领域服务 模块 定义的 `pause` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async pause(reason: GoalPauseReason = 'user'): Promise<GoalState> {
    const goal = this.requireStatus('active');
    const timestamp = this.now();
    const next = {
      ...goal,
      status: 'paused',
      updatedAt: timestamp.toISOString(),
      activeMs: elapsedActiveMs(goal, timestamp),
      pauseReason: reason,
    } satisfies GoalState;
    delete next.activeSince;
    await this.persist(next);
    return next;
  }

  /**
   * 校验恢复结果并继续 Thread 领域服务 模块 中唯一处于等待状态的执行。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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
    const next = {
      ...goal,
      status: 'active',
      updatedAt: timestamp,
      activeSince: timestamp,
      blockerStreak: 0,
    } satisfies GoalState;
    delete next.pauseReason;
    delete next.blockerReason;
    delete next.blockerFingerprint;
    await this.persist(next);
    return next;
  }

  /**
   * 按 Thread 领域服务 模块 的一致性约束执行 `clear` 状态变更。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 执行 Thread 领域服务 模块 定义的 `beginContinuation` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 按 Thread 领域服务 模块 的一致性约束执行 `recordUsage` 状态变更。
   *
   * Args:
   * - `goalId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `usage`: `recordUsage` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 按 Thread 领域服务 模块 的一致性约束执行 `update` 状态变更。
   *
   * Args:
   * - `status`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播。
   * - `runId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 Thread 领域服务 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 领域服务 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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

function withoutActiveSince(goal: GoalState): GoalState {
  const result = { ...goal };
  delete result.activeSince;
  return result;
}
