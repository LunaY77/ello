import type { ModelMessage } from 'ai';

import type { AgentStreamEvent } from './events.js';

/** 从流事件中积累 partial response parts。 */
export class PartialTextAccumulator {
  private partial: ModelMessage | null = null;

  /** 观察一个流事件, 积累 part 数据。 */
  observe(event: unknown): void {
    if (!isAgentStreamEvent(event)) {
      return;
    }

    if (event.type === 'message_start') {
      this.partial = event.message;
      return;
    }

    if (event.type === 'message_delta') {
      this.partial = event.partial;
      return;
    }

    if (event.type === 'message_end') {
      this.partial = event.message;
    }
  }

  /** 从已观察的 parts 构建 partial assistant message。 */
  buildResponse(): ModelMessage | null {
    return this.partial;
  }

  /** 重置积累器。 */
  reset(): void {
    this.partial = null;
  }
}

/**
 * 为未返回结果的 tool call 注入失败 tool result。
 *
 * 扫描消息历史, 找到没有对应 tool result 的 tool call, 追加 tool 消息。
 */
export function closeUnreturnedToolCalls(
  messages: ModelMessage[],
): ModelMessage[] {
  const pending = new Map<string, string>();

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          pending.set(part.toolCallId, part.toolName);
        }
      }
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          pending.delete(part.toolCallId);
        }
      }
    }
  }

  if (pending.size === 0) {
    return messages;
  }

  return [
    ...messages,
    {
      role: 'tool',
      content: [...pending.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([toolCallId, toolName]) => ({
          type: 'tool-result' as const,
          toolCallId,
          toolName,
          output: {
            type: 'text' as const,
            value:
              '[Error: tool execution was interrupted before returning a result]',
          },
        })),
    },
  ];
}

function isAgentStreamEvent(event: unknown): event is AgentStreamEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  return typeof (event as { type?: unknown }).type === 'string';
}
