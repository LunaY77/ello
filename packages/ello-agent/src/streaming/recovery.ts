import type { ModelMessage } from 'ai';

import type {
  RecoverableStreamEvent,
  StreamTextDelta,
  StreamTextPart,
} from './events.js';

/** 从流事件中积累 partial response parts。 */
export class PartialTextAccumulator {
  private readonly parts = new Map<number, StreamTextPart>();

  /** 观察一个流事件, 积累 part 数据。 */
  observe(event: unknown): void {
    const normalized = normalizeRecoverableStreamEvent(event);
    if (normalized === null) {
      return;
    }

    if (normalized.eventKind === 'part_start') {
      this.parts.set(normalized.index, normalized.part);
      return;
    }

    if (normalized.eventKind === 'part_delta') {
      const existing = this.parts.get(normalized.index);
      if (existing !== undefined && normalized.delta.deltaKind === 'text') {
        this.parts.set(normalized.index, {
          type: 'text',
          text: existing.text + normalized.delta.contentDelta,
        });
      }
      return;
    }

    this.parts.set(normalized.index, normalized.part);
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

function normalizeRecoverableStreamEvent(
  event: unknown,
): RecoverableStreamEvent | null {
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const source = event as {
    eventKind?: unknown;
    event_kind?: unknown;
    index?: unknown;
    part?: unknown;
    delta?: unknown;
  };
  const kind = source.eventKind ?? source.event_kind;
  const index = typeof source.index === 'number' ? source.index : null;

  if (
    (kind === 'part_start' || kind === 'part_end') &&
    index !== null &&
    source.part !== undefined
  ) {
    return {
      eventKind: kind,
      index,
      part: normalizeTextPart(source.part),
    };
  }

  if (kind === 'part_delta' && index !== null && source.delta !== undefined) {
    const delta = normalizeTextDelta(source.delta);
    if (delta === null) {
      return null;
    }
    return {
      eventKind: 'part_delta',
      index,
      delta,
    };
  }

  return null;
}

function normalizeTextPart(part: unknown): StreamTextPart {
  if (typeof part !== 'object' || part === null) {
    return { type: 'text', text: '' };
  }
  const source = part as { type?: unknown; text?: unknown; content?: unknown };
  return {
    type: 'text',
    text:
      typeof source.text === 'string'
        ? source.text
        : typeof source.content === 'string'
          ? source.content
          : '',
  };
}

function normalizeTextDelta(delta: unknown): StreamTextDelta | null {
  if (typeof delta !== 'object' || delta === null) {
    return null;
  }
  const source = delta as {
    deltaKind?: unknown;
    delta_kind?: unknown;
    contentDelta?: unknown;
    content_delta?: unknown;
  };
  const kind = source.deltaKind ?? source.delta_kind;
  if (kind !== 'text') {
    return null;
  }
  return {
    deltaKind: 'text',
    contentDelta:
      typeof source.contentDelta === 'string'
        ? source.contentDelta
        : typeof source.content_delta === 'string'
          ? source.content_delta
          : '',
  };
}
