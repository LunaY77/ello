import { randomUUID } from 'node:crypto';

/** 生成 8 字符的 entry ID。 */
export function generateEntryId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 8);
}

/** Session entry 公共字段。 */
export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

/** 存储一条序列化的 ModelMessage。 */
export interface MessageEntry extends SessionEntryBase {
  type: 'message';
  message: Record<string, unknown>;
}

/** 存储一次 compaction 的摘要和元数据。 */
export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: Record<string, unknown> | null;
}

/** 记录一次模型切换。 */
export interface ModelChangeEntry extends SessionEntryBase {
  type: 'model_change';
  modelName: string;
}

/** 存储任意元数据。 */
export interface MetadataEntry extends SessionEntryBase {
  type: 'metadata';
  key: string;
  value: unknown;
}

/** Session entry 联合类型。 */
export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | ModelChangeEntry
  | MetadataEntry;

/** 创建 message entry。 */
export function createMessageEntry(
  options: {
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    message?: Record<string, unknown>;
  } = {},
): MessageEntry {
  return {
    type: 'message',
    id: options.id ?? generateEntryId(),
    parentId: options.parentId ?? null,
    timestamp: options.timestamp ?? '',
    message: options.message ?? {},
  };
}

/** 创建 compaction entry。 */
export function createCompactionEntry(
  options: {
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore?: number;
    details?: Record<string, unknown> | null;
  } = {},
): CompactionEntry {
  return {
    type: 'compaction',
    id: options.id ?? generateEntryId(),
    parentId: options.parentId ?? null,
    timestamp: options.timestamp ?? '',
    summary: options.summary ?? '',
    firstKeptEntryId: options.firstKeptEntryId ?? '',
    tokensBefore: options.tokensBefore ?? 0,
    details: options.details ?? null,
  };
}

/** 创建 model change entry。 */
export function createModelChangeEntry(
  options: {
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    modelName?: string;
  } = {},
): ModelChangeEntry {
  return {
    type: 'model_change',
    id: options.id ?? generateEntryId(),
    parentId: options.parentId ?? null,
    timestamp: options.timestamp ?? '',
    modelName: options.modelName ?? '',
  };
}

/** 创建 metadata entry。 */
export function createMetadataEntry(
  options: {
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    key?: string;
    value?: unknown;
  } = {},
): MetadataEntry {
  return {
    type: 'metadata',
    id: options.id ?? generateEntryId(),
    parentId: options.parentId ?? null,
    timestamp: options.timestamp ?? '',
    key: options.key ?? '',
    value: options.value ?? null,
  };
}

/** Session 存储协议。 */
export interface SessionStorage {
  getMetadata(): Promise<Record<string, unknown>>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  appendEntry(entry: SessionEntry): Promise<void>;
  getEntry(entryId: string): Promise<SessionEntry | null>;
  getPathToRoot(leafId: string | null): Promise<SessionEntry[]>;
  getEntries(): Promise<SessionEntry[]>;
}
