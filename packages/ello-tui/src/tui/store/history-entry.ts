import type {
  UserInputResolution,
} from '../../api/protocol-types.js';
import type {
  ClientServerRequest,
} from '../../api/server-requests.js';

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: 'running' | 'ok' | 'fail';
  readonly output?: unknown;
  readonly error?: { readonly message: string; readonly code?: string };
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

export type UserInputRequest = Extract<
  ClientServerRequest,
  { readonly method: 'item/tool/requestUserInput' }
>;

export type HistoryEntry =
  | {
      readonly kind: 'session_header';
      readonly id: string;
      readonly threadId: string;
      readonly cwd: string;
      readonly profile: string;
      readonly model: string;
      readonly mode: string;
      readonly version?: string;
    }
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly entryId?: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly entryId?: string;
      readonly text: string;
    }
  | { readonly kind: 'skill'; readonly id: string; readonly name: string }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: ToolCallView }
  | {
      readonly kind: 'user_input';
      readonly id: string;
      readonly pending: UserInputRequest;
      readonly resolution?: UserInputResolution;
    }
  | {
      readonly kind: 'system';
      readonly id: string;
      readonly entryId?: string;
      readonly text: string;
    }
  | { readonly kind: 'subagent'; readonly id: string; readonly run: SubagentRunView }
  | { readonly kind: 'separator'; readonly id: string; readonly text: string }
  | { readonly kind: 'diagnostic'; readonly id: string; readonly text: string };

export interface ApprovalView {
  readonly request: Exclude<ClientServerRequest, UserInputRequest>;
  readonly requestId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly metadata?: Record<string, unknown>;
}
