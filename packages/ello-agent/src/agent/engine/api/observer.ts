import type {
  AgentRunContext,
  AgentRunResult,
  DeferredApprovalItem,
} from './agent.js';
import type { MaybePromise } from './model.js';
import type { AgentToolCall } from './tool.js';

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
  onRunCompleted?(
    result: AgentRunResult,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  onRunFailed?(
    event: { readonly error: import('./agent.js').AgentError },
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
}
