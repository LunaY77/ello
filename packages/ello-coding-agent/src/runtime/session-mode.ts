import { z } from 'zod';

/**
 * 会话级运行模式的唯一枚举。
 *
 * 模式不属于 agent 人格，也不允许 TUI 维护副本；权限、提示词和工具装配都应从
 * CodingSession 当前持有的 SessionModeState 派生。
 */
export const SessionModeSchema = z.enum([
  'plan',
  'default',
  'accept-edits',
  'bypass',
]);

export type SessionMode = z.infer<typeof SessionModeSchema>;

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
 * 计算快捷键循环的下一模式。
 *
 * bypass 只有安全开关已启用时才进入循环，前端不得自行复制这份顺序，否则容易出现
 * 状态栏已经切换、引擎仍停留在旧模式的双状态问题。
 */
export function cycleSessionMode(
  current: SessionMode,
  direction: 'next' | 'previous',
  bypassEnabled: boolean,
): SessionMode {
  const modes: readonly SessionMode[] = bypassEnabled
    ? ['default', 'accept-edits', 'plan', 'bypass']
    : ['default', 'accept-edits', 'plan'];
  const index = modes.indexOf(current);
  if (index < 0 || (!bypassEnabled && current === 'bypass')) {
    throw new Error(`Cannot cycle unavailable session mode: ${current}`);
  }
  const offset = direction === 'next' ? 1 : -1;
  return modes[(index + offset + modes.length) % modes.length]!;
}

/** 用户可见文案集中在引擎侧，避免不同前端对同一模式使用不同名称。 */
export function modeLabel(mode: SessionMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan';
    case 'default':
      return 'Default';
    case 'accept-edits':
      return 'Accept edits';
    case 'bypass':
      return 'Bypass';
  }
}
