import type { AgentMessage, AgentToolCall } from '../public/types.js';

export type ToolResultStatus = 'success' | 'error' | 'denied';

/** 构造一条 AI SDK v7 兼容的 assistant tool-call 消息。 */
export function createToolCallMessage(call: {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}): AgentMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: toJsonValue(call.input),
      },
    ],
  } as unknown as AgentMessage;
}

/** 构造一条 AI SDK v7 兼容的 tool-result 消息。 */
export function createToolResultMessage(
  call: Pick<AgentToolCall, 'id' | 'name' | 'input'>,
  output: unknown,
  status: ToolResultStatus = 'success',
): AgentMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.name,
        output: createToolOutput(output, status),
      },
    ],
  } as unknown as AgentMessage;
}

/** 收集消息中仍未配对 tool-result 的 tool-call id。 */
export function missingToolResultIds(
  messages: readonly AgentMessage[],
): readonly string[] {
  const pending = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    if (message.role === 'assistant') {
      for (const part of content) {
        if (isToolPart(part, 'tool-call')) {
          pending.add(part.toolCallId);
        }
      }
    } else if (message.role === 'tool') {
      for (const part of content) {
        if (isToolPart(part, 'tool-result')) {
          pending.delete(part.toolCallId);
        }
      }
    }
  }
  return [...pending];
}

/** 收集当前消息里已经存在的 tool-call id。 */
export function collectToolCallIds(
  messages: readonly AgentMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (isToolPart(part, 'tool-call')) {
        ids.add(part.toolCallId);
      }
    }
  }
  return ids;
}

function isToolPart(
  part: unknown,
  type: 'tool-call' | 'tool-result',
): part is { readonly type: string; readonly toolCallId: string } {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === type &&
    typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
  );
}

function createToolOutput(
  output: unknown,
  status: ToolResultStatus,
): unknown {
  if (status === 'denied') {
    return {
      type: 'execution-denied',
      ...(readReason(output) !== undefined
        ? { reason: readReason(output) }
        : {}),
    };
  }
  if (status === 'error') {
    return {
      type: 'error-text',
      value: readReason(output) ?? String(output),
    };
  }
  if (typeof output === 'string') {
    return { type: 'text', value: output };
  }
  return { type: 'json', value: toJsonValue(output) };
}

function readReason(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const reason =
      (value as Record<string, unknown>).reason ??
      (value as Record<string, unknown>).error;
    return typeof reason === 'string' ? reason : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}
