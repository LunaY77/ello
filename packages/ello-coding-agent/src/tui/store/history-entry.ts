import type { AgentError } from '@ello/agent';

import type {
  PendingUserInput,
  UserInputResolution,
} from '../../user-input/schema.js';

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: 'running' | 'ok' | 'fail';
  readonly output?: unknown;
  readonly error?: AgentError;
}

export interface ToolResultView {
  readonly kind?: string;
  readonly title?: string;
  readonly output?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SubagentRunView {
  readonly runId: string;
  readonly agentName: string;
  readonly description: string;
  readonly background: boolean;
  readonly status: 'running' | 'completed' | 'fail';
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly tools: readonly ToolCallView[];
  readonly output?: string;
  readonly error?: string;
}

export type HistoryEntry =
  | {
      readonly kind: 'session_header';
      readonly id: string;
      readonly cwd: string;
      readonly profile: string;
      readonly model: string;
      readonly mode: string;
      readonly version?: string;
    }
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly entryId?: string | undefined;
      readonly text: string;
    }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly entryId?: string | undefined;
      readonly text: string;
    }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: ToolCallView }
  | {
      readonly kind: 'user_input';
      readonly id: string;
      readonly pending: PendingUserInput;
      readonly resolution?: UserInputResolution;
    }
  | {
      readonly kind: 'system';
      readonly id: string;
      readonly entryId?: string | undefined;
      readonly text: string;
    }
  | {
      readonly kind: 'subagent';
      readonly id: string;
      readonly run: SubagentRunView;
    }
  | { readonly kind: 'separator'; readonly id: string; readonly text: string }
  | { readonly kind: 'diagnostic'; readonly id: string; readonly text: string };

export interface ApprovalView {
  readonly requestId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly metadata?: Record<string, unknown>;
}
