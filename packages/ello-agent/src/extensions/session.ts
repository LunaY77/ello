import { randomUUID } from 'node:crypto';

import type {
  AgentMessage,
  AgentRunResult,
  AgentSessionExtension,
} from '../public/types.js';

/** 会话条目。 */
export interface SessionEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  kind: 'message' | 'metadata' | 'compaction' | 'model_change';
  message?: AgentMessage;
  value?: unknown;
}

/**
 * 生成 session entry ID。
 *
 * Returns:
 *   无连字符 UUID 字符串。
 */
export function generateEntryId(): string {
  return randomUUID().replaceAll('-', '');
}

/**
 * 创建 message session entry。
 *
 * Args:
 *   options.message: 要持久化的 AgentMessage。
 *   options.parentId: 可选父 entry ID。
 *
 * Returns:
 *   可写入 JSONL 或内存 session 的 SessionEntry。
 */
export function createMessageEntry(options: {
  message: AgentMessage;
  parentId?: string | null;
}): SessionEntry {
  return {
    id: generateEntryId(),
    parentId: options.parentId ?? null,
    timestamp: new Date().toISOString(),
    kind: 'message',
    message: options.message,
  };
}

/**
 * 默认内存 session 扩展。
 *
 * Returns:
 *   AgentSessionExtension，并额外暴露只读 messages 便于测试或 UI 查看。
 *
 * @example
 * ```ts
 * const session = createMemorySession();
 * const agent = createAgent({ model, extensions: [session] });
 * ```
 */
export function createMemorySession(): AgentSessionExtension & {
  readonly messages: readonly AgentMessage[];
} {
  const messages: AgentMessage[] = [];
  return {
    name: 'memory-session',
    get messages() {
      return messages;
    },
    loadMessages() {
      return [...messages];
    },
    saveResult(result: AgentRunResult) {
      messages.splice(0, messages.length, ...result.messages);
    },
  };
}

/**
 * 创建 JSONL session 扩展适配器。
 *
 * JSONL 的文件格式、分支元数据和索引由产品层实现；核心只调用
 * loadMessages/saveResult，因此不会绑定具体持久化实现。
 *
 * Args:
 *   options.loadMessages: run 开始前读取历史消息。
 *   options.saveResult: run 完成后保存结果。
 *
 * Returns:
 *   AgentSessionExtension。
 */
export function createJsonlSession(options: {
  loadMessages: () => AgentMessage[] | Promise<AgentMessage[]>;
  saveResult: (result: AgentRunResult) => void | Promise<void>;
}): AgentSessionExtension {
  return {
    name: 'jsonl-session',
    loadMessages: options.loadMessages,
    saveResult: options.saveResult,
  };
}
