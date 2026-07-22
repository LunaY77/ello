/**
 * 本文件负责 tool feature 的“session-mode”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { SessionMode } from '../../../protocol/v1/index.js';

/**
 * 会话级运行模式的唯一枚举。
 *
 * 模式不属于 agent 人格，也不允许 TUI 维护副本；权限、提示词和工具装配都应从
 * Thread runtime 当前持有的 SessionModeState 派生。
 */
export type { SessionMode } from '../../../protocol/v1/index.js';

/** 模式变更来源会随事件持久化，便于恢复和诊断“是谁切换了模式”。 */
export type SessionModeSource =
  | 'config'
  | 'shortcut'
  | 'slash-command'
  | 'plan-accept'
  | 'resume';

export interface SessionModeState {
  readonly mode: SessionMode;
  readonly previousMode: SessionMode | null;
  readonly source: SessionModeSource;
  readonly changedAt: string;
}

/** Plan 模式对外稳定错误码；UI 只展示，不应吞掉或改写。 */
export type PlanModeErrorCode =
  | 'PLAN_TASK_REQUIRED'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_STATE_INVALID'
  | 'PLAN_REQUEST_STALE'
  | 'PLAN_HASH_MISMATCH'
  | 'MODE_CHANGE_WHILE_RUNNING'
  | 'MODE_NOT_ALLOWED'
  | 'SUBAGENT_MODE_MISMATCH'
  | 'SESSION_PROTOCOL_INVALID';

export class PlanModeError extends Error {
  readonly code: PlanModeErrorCode;
  readonly sessionId: string;
  readonly state: unknown;
  readonly requestId?: string;

  /**
   * 创建 `PlanModeError`，由该实例独占 工具 `session-mode` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `input`: `constructor PlanModeError` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   */
  constructor(input: {
    readonly code: PlanModeErrorCode;
    readonly message: string;
    readonly sessionId: string;
    readonly state: unknown;
    readonly requestId?: string;
  }) {
    super(input.message);
    this.name = 'PlanModeError';
    this.code = input.code;
    this.sessionId = input.sessionId;
    this.state = input.state;
    if (input.requestId !== undefined) this.requestId = input.requestId;
  }
}

/**
 * 用户可见文案集中在引擎侧，避免不同前端对同一模式使用不同名称。
 *
 * Args:
 * - `mode`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
 *
 * Returns:
 * - 返回 `modeLabel` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function modeLabel(mode: SessionMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan';
    case 'ask-before-changes':
      return 'Ask before changes';
    case 'accept-edits':
      return 'Accept edits';
    case 'bypass':
      return 'Bypass';
  }
}
