import type {
  AgentMessage,
  CreateAgentOptions,
  MessageTransform,
} from '../public/types.js';

import type { RunSession } from './run-session.js';

export interface TrimMessagesOptions {
  readonly maxMessages: number;
}

export function trimMessages(options: TrimMessagesOptions): MessageTransform {
  return async (messages) =>
    preserveToolCallPairs(messages.slice(-options.maxMessages));
}

export interface CompactMessagesOptions {
  readonly maxInputTokens: number;
  readonly reservedOutputTokens?: number;
}

export function compactMessages(
  options: CompactMessagesOptions,
): MessageTransform {
  return async (messages) => applyTokenBudget(messages, options);
}

export function defaultMessageTransforms(run: RunSession): MessageTransform[] {
  const transforms: MessageTransform[] = [];
  if (run.config.sessionWindow !== undefined) {
    transforms.push(trimMessages(run.config.sessionWindow));
  }
  if (run.config.modelInputBudget !== undefined) {
    transforms.push(compactMessages(run.config.modelInputBudget));
  }
  transforms.push(async (messages) => preserveToolCallPairs(messages));
  return transforms;
}

export function estimateMessagesTokens(
  messages: readonly AgentMessage[],
): number {
  return messages.reduce(
    (sum, message) => sum + estimateTextTokens(messageText(message)),
    0,
  );
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function applyTokenBudget(
  messages: readonly AgentMessage[],
  options: CompactMessagesOptions,
): readonly AgentMessage[] {
  const available = Math.max(
    0,
    options.maxInputTokens - (options.reservedOutputTokens ?? 0),
  );
  const kept = [...messages];
  while (kept.length > 0 && estimateMessagesTokens(kept) > available) {
    kept.shift();
  }
  return preserveToolCallPairs(kept);
}

export function preserveToolCallPairs(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const id of readPartIds(message, 'tool-call')) {
        toolCallIds.add(id);
      }
    }
    if (message.role === 'tool') {
      for (const id of readPartIds(message, 'tool-result')) {
        toolResultIds.add(id);
      }
    }
  }
  return messages.filter((message) => {
    if (message.role === 'assistant') {
      const ids = readPartIds(message, 'tool-call');
      return ids.length === 0 || ids.some((id) => toolResultIds.has(id));
    }
    if (message.role === 'tool') {
      const ids = readPartIds(message, 'tool-result');
      return ids.length === 0 || ids.some((id) => toolCallIds.has(id));
    }
    return true;
  });
}

function readPartIds(message: AgentMessage, type: string): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (typeof part !== 'object' || part === null) {
      return [];
    }
    const record = part as Record<string, unknown>;
    if (record.type !== type) {
      return [];
    }
    const id = record.toolCallId ?? record.toolInvocationId;
    return typeof id === 'string' ? [id] : [];
  });
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

export function createSummarySessionCompactor(options: {
  readonly maxMessages: number;
  readonly keepMessages: number;
}): NonNullable<CreateAgentOptions['compactor']> {
  return {
    name: 'summary-session-compactor',
    async maybeCompact(sessionId, store, ctx) {
      const messages = await store.load(sessionId);
      if (
        messages.length <= options.maxMessages ||
        store.replace === undefined
      ) {
        return null;
      }
      const summarized = messages.slice(0, -options.keepMessages);
      const kept = messages.slice(-options.keepMessages);
      const summary: AgentMessage = {
        role: 'user',
        content: `<session-summary>\n${summarizeMessages(summarized)}\n</session-summary>`,
      };
      const next = [summary, ...kept];
      await store.replace(sessionId, next, {
        compactor: 'summary-session-compactor',
      });
      void ctx;
      return {
        compactor: 'summary-session-compactor',
        beforeMessageCount: messages.length,
        afterMessageCount: next.length,
      };
    },
  };
}

function summarizeMessages(messages: readonly AgentMessage[]): string {
  return messages
    .map((message) => `${message.role}: ${messageText(message)}`)
    .join('\n')
    .slice(0, 4000);
}
