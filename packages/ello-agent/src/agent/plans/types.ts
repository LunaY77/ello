import type { SessionModeState } from '../../domain/thread/session-mode.js';

/** `/plan` 是否携带输入必须显式建模，空 Preview 与提交任务不能混为一条路径。 */
export type PlanSlashCommand =
  | { readonly kind: 'without-input' }
  | { readonly kind: 'with-input'; readonly input: string };

export interface PlanPreview {
  readonly sessionId: string;
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
  readonly status: PlanRecord['status'];
}

/** Slash Command 只返回业务结果；模型调用和模式转换仍由 Thread runtime 完成。 */
export type PlanCommandResult =
  | {
      readonly kind: 'entered';
      readonly mode: SessionModeState;
      readonly runId: string;
    }
  | { readonly kind: 'previewed'; readonly preview: PlanPreview }
  | { readonly kind: 'submitted'; readonly runId: string }
  | { readonly kind: 'steered'; readonly runId: string };

interface PlanRecordBase {
  readonly sessionId: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Plan 持久化状态使用判别联合，确保状态专属字段无法出现在错误阶段：
 * requestId 只属于待审批状态，executionSessionId 只属于已接受状态。
 */
export type PlanRecord =
  | (PlanRecordBase & { readonly status: 'draft' })
  | (PlanRecordBase & {
      readonly status: 'awaiting-approval';
      readonly requestId: string;
    })
  | (PlanRecordBase & {
      readonly status: 'accepted';
      readonly executionSessionId: string;
    })
  | (PlanRecordBase & {
      readonly status: 'rejected';
      readonly reason: string | null;
    });
