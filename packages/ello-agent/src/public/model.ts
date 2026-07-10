import type {
  LanguageModel,
  ModelMessage as AiModelMessage,
  ToolChoice,
  ToolSet,
} from 'ai';

import type {
  AgentFinishReason,
  AgentRunContext,
  AgentUsage,
} from './agent.js';
import type { AgentToolCall } from './tool.js';

export type AgentMessage = AiModelMessage;
export type UserMessage = Extract<AiModelMessage, { role: 'user' }>;
export type AssistantMessage = Extract<AiModelMessage, { role: 'assistant' }>;
export type AgentModel = string | LanguageModel;
export type AgentToolSet = ToolSet;
export type AgentToolChoice = ToolChoice<ToolSet>;

export interface ModelInput {
  readonly system?: string;
  readonly messages: AgentMessage[];
  readonly tools: AgentToolSet;
  readonly activeTools?: readonly string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: Record<string, unknown>;
  readonly diagnostics?: ModelInputDiagnostics;
}

export interface ModelInputDiagnostics {
  readonly systemSections: number;
  readonly messageCount: number;
  readonly estimatedInputTokens?: number;
  readonly activeTools?: readonly string[];
  readonly hasProviderOptions: boolean;
  readonly appliedMessageTransforms: readonly string[];
  readonly systemFingerprint: string;
  readonly toolsetFingerprint: string;
  readonly messagePrefixFingerprint: string;
  readonly compactionBoundary: boolean;
}

export type SystemSection<TContext = unknown> = (
  run: AgentRunContext<TContext>,
) => MaybePromise<string | null | undefined>;

export type MessageTransform<TContext = unknown> = (
  messages: readonly AgentMessage[],
  run: AgentRunContext<TContext>,
) => MaybePromise<readonly AgentMessage[]>;

export type ProviderOptionsResolver<TContext = unknown> = (
  run: AgentRunContext<TContext>,
) => MaybePromise<Record<string, unknown> | null | undefined>;

export type PrepareModelInput<TContext = unknown> = (
  input: ModelInput,
  run: AgentRunContext<TContext>,
) => MaybePromise<ModelInput>;

export interface AgentModelRequest {
  readonly runId: string;
  readonly model: AgentModel;
  readonly system?: string;
  readonly messages: AgentMessage[];
  readonly tools: ToolSet;
  readonly activeTools?: readonly string[];
  readonly toolChoice?: AgentToolChoice;
  readonly providerOptions?: Record<string, unknown>;
  readonly modelSettings: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface AgentModelResponse {
  readonly text: string;
  readonly messages: AgentMessage[];
  readonly newMessages?: AgentMessage[];
  readonly toolCalls?: AgentToolCall[];
  readonly toolResults?: unknown[];
  readonly usage: AgentUsage;
  readonly finishReason: AgentFinishReason;
  readonly provider: unknown;
}

export type AgentModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'final'; response: AgentModelResponse };

export interface ModelAdapter {
  generate(request: AgentModelRequest): Promise<AgentModelResponse>;
  stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent>;
}

export type MaybePromise<T> = T | Promise<T>;
