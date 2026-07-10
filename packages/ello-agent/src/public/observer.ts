import type {
  AgentFinishReason,
  AgentRunContext,
  AgentRunResult,
  AgentUsage,
  DeferredApprovalItem,
} from './agent.js';
import type { MaybePromise } from './model.js';
import type { AgentToolCall } from './tool.js';

export interface ModelCallCompletedEvent {
  readonly runId: string;
  readonly turnIndex: number;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: AgentFinishReason;
  readonly usage: AgentUsage;
  readonly durationMs: number;
  readonly systemFingerprint: string;
  readonly toolsetFingerprint: string;
  readonly messagePrefixFingerprint: string;
  readonly compactionBoundary: boolean;
}

export interface AgentObserver<TContext = unknown> {
  onRunStarted?(
    event: { readonly runId: string },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onTurnStarted?(
    event: { readonly runId: string; readonly turnIndex: number },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onToolScheduled?(
    event: AgentToolCall,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onToolApprovalRequired?(
    event: DeferredApprovalItem,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onToolCompleted?(
    event: AgentToolCall,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onModelCallCompleted?(
    event: ModelCallCompletedEvent,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onRunCompleted?(
    result: AgentRunResult,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onRunFailed?(
    event: { readonly error: import('./agent.js').AgentError },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
}
