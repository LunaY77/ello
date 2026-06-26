import type { ModelMessage } from 'ai';

import type { RecoverableStreamEvent, StreamTextPart } from './events.js';

/** 从流事件中积累 partial response parts。 */
export class PartialTextAccumulator {
  private readonly parts = new Map<number, StreamTextPart>();

  /** 观察一个流事件, 积累 part 数据。 */
  observe(event: unknown): void {
    if (!isRecoverableStreamEvent(event)) {
      return;
    }

    if (event.eventKind === 'part_start') {
      this.parts.set(event.index, event.part);
      return;
    }

    if (event.eventKind === 'part_delta') {
      const existing = this.parts.get(event.index);
      if (existing !== undefined && event.delta.deltaKind === 'text') {
        this.parts.set(event.index, {
          type: 'text',
          text: existing.text + event.delta.contentDelta,
        });
      }
      return;
    }

    this.parts.set(event.index, event.part);
  }

  /** 从已观察的 parts 构建 partial assistant message。 */
  buildResponse(): ModelMessage | null {
    if (this.parts.size === 0) {
      return null;
    }
    const content = [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => ({ type: 'text' as const, text: part.text }));
    return { role: 'assistant', content };
  }

  /** 重置积累器。 */
  reset(): void {
    this.parts.clear();
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

function isRecoverableStreamEvent(
  event: unknown,
): event is RecoverableStreamEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  const kind = (event as { eventKind?: unknown }).eventKind;
  return kind === 'part_start' || kind === 'part_delta' || kind === 'part_end';
}
