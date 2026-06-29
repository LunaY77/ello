import type { AgentRunResult, AgentStreamEvent } from '@ello/agent';

import type { RuleScope } from '../permission/rules-store.js';

/**
 * 审批决定。
 *
 * 前端把用户在审批浮层的选择翻译成这个意图，交给 {@link CodingSession.approve}：
 * - `approve_once`：仅本次放行；
 * - `always_allow`：放行并按 `scope` 落一条 allow 规则（session/project）；
 * - `deny`：拒绝本次工具调用。
 */
export interface ApprovalDecision {
  readonly action: 'approve_once' | 'always_allow' | 'deny';
  readonly scope?: RuleScope;
  readonly reason?: string;
}

/** 运行时状态机的三个对外状态。 */
export type CodingSessionState = 'idle' | 'running' | 'awaiting_approval';

/**
 * 转发给前端的事件 = `@ello/agent` 原生事件 + 少量产品级事件。
 *
 * 这是 **union 扩展**而不是 wrapper——内核事件原样透传，产品事件只在确实需要时
 * 附加（会话开/切、状态、审批待决、用量）。
 */
export type CodingSessionEvent =
  | AgentStreamEvent
  | {
      readonly type: 'session.opened';
      readonly sessionId: string;
      readonly cwd: string;
    }
  | { readonly type: 'session.switched'; readonly sessionId: string }
  | { readonly type: 'model.changed'; readonly model: string }
  | { readonly type: 'status'; readonly state: CodingSessionState }
  | { readonly type: 'ui.message'; readonly text: string }
  | { readonly type: 'ui.clear' }
  | { readonly type: 'ui.interrupted'; readonly reason: string }
  | {
      readonly type: 'approval.pending';
      readonly requestId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | { readonly type: 'usage'; readonly usage: AgentRunResult['usage'] };

/** 前端订阅运行时事件的监听器。 */
export type CodingEventListener = (event: CodingSessionEvent) => void;
