import type { AgentRunContext, SessionCompactionReport } from './agent.js';
import type { AgentStreamEvent } from './events.js';
import type { AgentMessage, MaybePromise } from './model.js';

export interface TranscriptStore {
  load(sessionId: string): Promise<AgentMessage[]>;
  append(
    sessionId: string,
    messages: AgentMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface CompactionPort<TContext = unknown> {
  readonly name: string;
  maybeCompact(
    sessionId: string,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<SessionCompactionReport | null>;
}

export interface AgentEventRecorder<TContext = unknown> {
  record(
    event: AgentStreamEvent,
    ctx: AgentRunContext<TContext>,
  ): MaybePromise<void>;
  flush?(ctx: AgentRunContext<TContext>): MaybePromise<void>;
}
