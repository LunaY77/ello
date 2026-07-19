import { createHash } from 'node:crypto';

import type { AgentMessage, AgentToolSet } from '../api/types.js';

/** 对模型输入的稳定部分生成不含正文的 SHA-256 指纹。 */
export function fingerprintSystem(
  system: string | undefined,
  messages: readonly AgentMessage[] = [],
): string {
  const leadingSystemMessages: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'system') {
      break;
    }
    leadingSystemMessages.push(message);
  }
  return sha256(stableJson({ system, leadingSystemMessages }));
}

export function fingerprintToolset(tools: AgentToolSet): string {
  const definitions = Object.entries(tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: schemaJson(tool.inputSchema),
      providerOptions: tool.providerOptions,
    }));
  return sha256(stableJson(definitions));
}

export function fingerprintMessagePrefix(
  messages: readonly AgentMessage[],
): string {
  return sha256(stableJson(messages.slice(0, -1)));
}

export function hasCompactionBoundary(
  messages: readonly AgentMessage[],
): boolean {
  return messages.some((message) =>
    stableJson(message).includes('<compact-checkpoint>'),
  );
}

function schemaJson(schema: unknown): unknown {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    'toJSONSchema' in schema &&
    typeof schema.toJSONSchema === 'function'
  ) {
    return schema.toJSONSchema();
  }
  if (typeof schema === 'object' && schema !== null && 'jsonSchema' in schema) {
    return schema.jsonSchema;
  }
  throw new Error('Tool input schema does not expose JSON Schema.');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
