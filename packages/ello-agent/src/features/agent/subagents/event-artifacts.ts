/**
 * 本文件把过大的子代理工具结果转存到 ArtifactStore，并生成有界的 transcript payload。
 *
 * AgentRun 仍消费原始事件；这里只改变持久化和 RPC 使用的公开副本，避免 SQLite 无界增长。
 */
import type { ArtifactStore } from '../../artifact/index.js';

import type { PrepareAgentTaskEvent } from './task-service.js';

const INLINE_EVENT_OUTPUT_BYTES = 32 * 1024;
const OUTPUT_PREVIEW_BYTES = 4 * 1024;

/** 创建使用仓库 ArtifactStore 的子代理事件预处理器。 */
export function createAgentTaskEventPreparer(
  artifacts: ArtifactStore,
): PrepareAgentTaskEvent {
  return async (task, event) => {
    if (
      event.type !== 'commandRunEvent' ||
      event.event.type !== 'command.completed' ||
      event.event.record.output === undefined
    ) {
      return event;
    }
    const record = event.event.record;
    const serialized = serializeOutput(record.output);
    if (
      Buffer.byteLength(serialized.content, 'utf8') <= INLINE_EVENT_OUTPUT_BYTES
    ) {
      return event;
    }
    const artifact = await artifacts.put({
      kind: 'agent-task-tool-output',
      content: serialized.content,
      contentType: serialized.contentType,
      owner: {
        kind: 'tool-result',
        id: `${task.id}:${record.commandId}`,
        relation: 'agent-task-transcript',
      },
    });
    return {
      ...event,
      event: {
        ...event.event,
        record: {
          ...record,
          output: {
            output: previewOutput(record.output, serialized.content),
            metadata: {
              ...boundedMetadata(record.output),
              artifactId: artifact.id,
              artifactBytes: artifact.byteSize,
              artifactContentType: artifact.contentType,
              truncated: true,
            },
          },
        },
      },
    };
  };
}

function serializeOutput(output: unknown): {
  readonly content: string;
  readonly contentType: string;
} {
  if (typeof output === 'string') {
    return { content: output, contentType: 'text/plain; charset=utf-8' };
  }
  return {
    content: JSON.stringify(output, null, 2) ?? String(output),
    contentType: 'application/json',
  };
}

function previewOutput(output: unknown, serialized: string): string {
  const source =
    typeof output === 'object' && output !== null && 'output' in output
      ? (output as { readonly output?: unknown }).output
      : output;
  return utf8Preview(typeof source === 'string' ? source : serialized);
}

function boundedMetadata(output: unknown): Readonly<Record<string, unknown>> {
  if (
    typeof output !== 'object' ||
    output === null ||
    !('metadata' in output)
  ) {
    return {};
  }
  const metadata = (output as { readonly metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, 64)
      .map(([key, value]) => [key, boundedValue(value, 0)]),
  );
}

function boundedValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return utf8Preview(value, 2 * 1024);
  if (depth >= 3) return '[nested value omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => boundedValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([key, entry]) => [key, boundedValue(entry, depth + 1)]),
    );
  }
  return String(value);
}

function utf8Preview(value: string, maxBytes = OUTPUT_PREVIEW_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${value.slice(0, low)}\n... [full output stored as artifact]`;
}
