import type { AgentMessage } from '@ello/agent';

import { logicalToolCall } from '../../tools/meta-tools.js';

import type { HistoryEntry, ToolCallView } from './history-entry.js';

export function messagesToHistoryEntries(
  messages: readonly AgentMessage[],
  entryIds: readonly string[] | undefined,
): readonly HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const toolCalls = new Map<
    string,
    { readonly id: string; readonly name: string; readonly input: unknown }
  >();

  messages.forEach((message, index) => {
    const calls = readToolCalls(message);
    for (const call of calls) {
      toolCalls.set(call.id, call);
    }
    const results = readToolResults(message);
    if (results.length > 0) {
      for (const result of results) {
        const call = toolCalls.get(result.id);
        if (call === undefined) {
          throw new Error(
            `Tool result without tool call: message=${index} toolCallId=${result.id}`,
          );
        }
        entries.push({
          kind: 'tool',
          id: `history-tool-${index}-${result.id}`,
          tool: {
            id: result.id,
            name: call.name,
            input: call.input,
            status: result.status,
            ...(result.output !== undefined ? { output: result.output } : {}),
          },
        });
      }
      return;
    }
    if (calls.length > 0) {
      return;
    }
    const text = messageContentText(message);
    if (!text.trim()) {
      return;
    }
    if (message.role === 'user') {
      entries.push({
        kind: 'user',
        id: `history-user-${index}`,
        ...(entryIds?.[index] !== undefined
          ? { entryId: entryIds[index] }
          : {}),
        text,
      });
      return;
    }
    if (message.role === 'assistant') {
      entries.push({
        kind: 'assistant',
        id: `history-assistant-${index}`,
        ...(entryIds?.[index] !== undefined
          ? { entryId: entryIds[index] }
          : {}),
        text,
      });
      return;
    }
    entries.push({
      kind: 'system',
      id: `history-message-${index}`,
      ...(entryIds?.[index] !== undefined ? { entryId: entryIds[index] } : {}),
      text,
    });
  });
  return entries;
}

export function messageContentText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (isToolCallOnlyContent(content)) {
    return '';
  }
  return JSON.stringify(content);
}

function readToolCalls(message: AgentMessage): Array<{
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}> {
  if (message.role !== 'assistant') {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== 'tool-call') {
      return [];
    }
    const id = readString(part.toolCallId ?? part.id);
    const name = readString(part.toolName ?? part.name);
    if (id === undefined || name === undefined) {
      return [];
    }
    if (!Object.hasOwn(part, 'input')) {
      return [];
    }
    const logical = logicalToolCall({ name, input: part.input });
    return [{ id, name: logical.name, input: logical.input }];
  });
}

function readToolResults(message: AgentMessage): Array<{
  readonly id: string;
  readonly name?: string;
  readonly output?: unknown;
  readonly status: ToolCallView['status'];
}> {
  if (message.role !== 'tool') {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== 'tool-result') {
      return [];
    }
    const id = readString(part.toolCallId ?? part.id);
    if (id === undefined) {
      return [];
    }
    const output = part.output;
    const name = readString(part.toolName ?? part.name);
    return [
      {
        id,
        ...(name !== undefined ? { name } : {}),
        ...(output !== undefined
          ? { output: normalizeToolOutput(output) }
          : {}),
        status: isToolErrorOutput(output) ? 'fail' : 'ok',
      },
    ];
  });
}

function normalizeToolOutput(output: unknown): unknown {
  if (!isRecord(output)) {
    return output;
  }
  if (output.type === 'text') {
    return output.value;
  }
  if (output.type === 'json') {
    return normalizeToolOutput(output.value);
  }
  if (output.type === 'error-text') {
    return output.value;
  }
  return output;
}

function isToolErrorOutput(output: unknown): boolean {
  return isRecord(output) && output.type === 'error-text';
}

function isToolCallOnlyContent(content: unknown): boolean {
  if (Array.isArray(content)) {
    return (
      content.length > 0 &&
      content.every((part) => isRecord(part) && part.type === 'tool-call')
    );
  }
  return isRecord(content) && content.type === 'tool-call';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
