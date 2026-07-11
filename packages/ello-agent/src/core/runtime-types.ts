import type {
  AgentRunContext,
  AgentFinishReason,
  AgentUsage,
  QueueDrainDiagnostic,
} from '../public/agent.js';
import type { AgentEventMetadata, AgentStreamEvent } from '../public/events.js';
import type { AgentMessage } from '../public/model.js';

export interface AgentRunState {
  readonly messages: AgentMessage[];
  readonly budget: Record<string, unknown>;
  readonly turn: number;
  readonly queueDiagnostics: QueueDrainDiagnostic[];
}

export type AgentTraceEvent =
  | Extract<
      AgentStreamEvent,
      { type: 'run.started' | 'turn.started' | 'turn.completed' }
    >
  | (AgentEventMetadata & {
      readonly type: 'tool.started';
      readonly toolCallId: string;
      readonly name: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.approval_requested';
      readonly toolCallId: string;
      readonly toolName: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'approval.required';
      readonly runId: string;
      readonly toolCallId: string;
      readonly toolName: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.completed';
      readonly toolCallId: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.failed';
      readonly toolCallId: string;
      readonly errorName: string;
      readonly errorMessage: string;
    })
  | (AgentEventMetadata & { readonly type: 'run.interrupted' })
  | (AgentEventMetadata & {
      readonly type: 'run.completed';
      readonly runId: string;
      readonly finishReason: AgentFinishReason;
      readonly usage: AgentUsage;
    })
  | (AgentEventMetadata & {
      readonly type: 'run.failed';
      readonly runId: string;
      readonly errorName: string;
      readonly errorMessage: string;
    });

export interface AgentTrace {
  readonly events: AgentTraceEvent[];
  readonly metadata: Record<string, unknown>;
}

export interface InternalAgentRunContext<
  TContext = unknown,
> extends AgentRunContext<TContext> {
  readonly state: AgentRunState;
  readonly trace: AgentTrace;
}

export type AgentMessageQueueMode = 'all' | 'one-at-a-time';

export interface AgentMessageQueue<T = AgentMessage> {
  readonly mode: AgentMessageQueueMode;
  readonly size: number;
  readonly hasItems: boolean;
  push(item: T): void;
  drain(): T[];
  clear(): void;
}

export type AgentRunControlStatus =
  | 'running'
  | 'waiting_approval'
  | 'interrupted'
  | 'completed'
  | 'failed';
