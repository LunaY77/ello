import type { AgentInput, AgentMessage } from '../public/types.js';

/**
 * 将公开输入统一为 ModelMessage 序列。
 *
 * Args:
 *   input: string、AgentMessage[] 或结构化 AgentInput。
 *
 * Returns:
 *   可直接传给模型 adapter 的 AgentMessage[]。
 */
export function normalizeInput(input: AgentInput): AgentMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return [...input];
  }
  if (input.messages !== undefined) {
    return [...input.messages];
  }
  if (input.prompt !== undefined) {
    return [{ role: 'user', content: input.prompt }];
  }
  return [];
}

export function diffNewMessages(
  before: readonly AgentMessage[],
  after: readonly AgentMessage[],
): AgentMessage[] {
  if (after.length >= before.length) {
    const prefixMatches = before.every((message, index) =>
      messagesEqual(message, after[index]),
    );
    if (prefixMatches) {
      return after.slice(before.length);
    }
  }
  return after.length === 0 ? [] : after.slice(-1);
}

function messagesEqual(left: AgentMessage, right: AgentMessage | undefined): boolean {
  if (right === undefined || left.role !== right.role) {
    return false;
  }
  return stableContent(left) === stableContent(right);
}

function stableContent(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content ?? null);
}
