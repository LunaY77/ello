import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { AgentMessage, AgentStreamEvent } from '@ello/agent';

/** JSONL session 文件版本。 */
export const SESSION_FILE_VERSION = 1;

/** 一个会话文件的元信息。 */
export interface SessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly path: string;
  readonly createdAt: string;
  readonly activeEntryId?: string;
}

/**
 * 一次压缩边界的描述。
 *
 * `summary` 为压缩摘要正文，`boundaryEntryId` 指向压缩发生时的 active leaf，
 * 便于回放时定位“摘要之前的历史”。
 */
export interface CompactSummary {
  readonly id: string;
  readonly boundaryEntryId?: string;
  readonly summary: string;
}

/** append-only session tree 的记录形状。 */
export type SessionRecord =
  | {
      readonly kind: 'header';
      readonly sessionId: string;
      readonly cwd: string;
      readonly createdAt: string;
      readonly version: number;
    }
  | {
      readonly kind: 'entry';
      readonly id: string;
      readonly parentId: string | null;
      readonly type: 'message';
      readonly message: AgentMessage;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'entry';
      readonly id: string;
      readonly parentId: string | null;
      readonly type: 'event';
      readonly event: AgentStreamEvent;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'leaf';
      readonly entryId: string | null;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'branch';
      readonly from: string | null;
      readonly to: string;
      readonly reason: string;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'compaction';
      readonly id: string;
      readonly boundaryEntryId?: string;
      readonly summary: string;
      readonly createdAt: string;
    };

/** session list 的摘要。 */
export interface JsonlSessionSummary {
  readonly sessionId: string;
  readonly path: string;
  readonly cwd: string;
  readonly entryCount: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastUserText?: string;
  readonly lastAssistantText?: string;
  readonly lastToolText?: string;
}

/** active path 的读取结果。 */
export interface ActiveSessionPath {
  readonly info: SessionInfo;
  readonly records: SessionRecord[];
  readonly messages: AgentMessage[];
  readonly leafEntryId: string | null;
}

/** TUI/RPC 使用的 session tree 节点。 */
export interface SessionTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: 'message' | 'event';
  readonly label: string;
  readonly createdAt: string;
  readonly active: boolean;
}

/** session tree 读取结果。 */
export interface SessionTreeView {
  readonly sessionId: string;
  readonly activeEntryId: string | null;
  readonly nodes: SessionTreeNode[];
  readonly branches: Array<{
    readonly from: string | null;
    readonly to: string;
    readonly reason: string;
    readonly createdAt: string;
  }>;
  readonly compactions: Array<{
    readonly id: string;
    readonly boundaryEntryId?: string;
    readonly summary: string;
    readonly createdAt: string;
  }>;
}

/**
 * append-only JSONL 会话仓库。
 *
 * 文件结构显式区分 header、entry、leaf、branch 和 compaction，避免旧实现把
 * result.messages 全量重复写入。仓库只暴露 active path 和 append 操作，
 * UI 不需要理解磁盘格式。
 */
export class JsonlSessionRepository {
  constructor(
    private readonly options: {
      readonly sessionDir: string;
      readonly cwd: string;
    },
  ) {}

  /** 创建或打开一个 session。 */
  async open(sessionId: string = randomUUID()): Promise<ActiveSessionPath> {
    await mkdir(this.options.sessionDir, { recursive: true });
    const filePath = this.filePath(sessionId);
    try {
      await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const createdAt = new Date().toISOString();
      await writeFile(
        filePath,
        `${JSON.stringify({ kind: 'header', sessionId, cwd: this.options.cwd, createdAt, version: SESSION_FILE_VERSION } satisfies SessionRecord)}\n`,
        'utf8',
      );
    }
    return this.load(sessionId);
  }

  /** 读取 active branch 的消息和元数据。 */
  async load(sessionId: string): Promise<ActiveSessionPath> {
    const records = await this.readRecords(sessionId);
    const header = records.find(
      (record): record is Extract<SessionRecord, { kind: 'header' }> =>
        record.kind === 'header',
    );
    if (header === undefined) {
      throw new Error(`Invalid session ${sessionId}: missing header`);
    }
    const leaf = findLeaf(records);
    const activeRecords = buildActivePath(records, leaf);
    const messages = activeRecords.flatMap((record) =>
      record.kind === 'entry' && record.type === 'message'
        ? [record.message]
        : [],
    );
    return {
      info: {
        sessionId: header.sessionId,
        cwd: header.cwd,
        path: this.filePath(sessionId),
        createdAt: header.createdAt,
        ...(leaf !== null ? { activeEntryId: leaf } : {}),
      },
      records: activeRecords,
      messages,
      leafEntryId: leaf,
    };
  }

  /** 追加消息增量。 */
  async appendMessages(
    sessionId: string,
    parentId: string | null,
    messages: readonly AgentMessage[],
  ): Promise<string | null> {
    let leaf = parentId;
    const records: SessionRecord[] = [];
    for (const message of messages) {
      const id = randomUUID();
      records.push({
        kind: 'entry',
        id,
        parentId: leaf,
        type: 'message',
        message,
        createdAt: new Date().toISOString(),
      });
      leaf = id;
    }
    if (records.length > 0) {
      records.push({
        kind: 'leaf',
        entryId: leaf,
        createdAt: new Date().toISOString(),
      });
      await this.appendRecords(sessionId, records);
    }
    return leaf;
  }

  /** 追加内核事件（回放用，可选）。 */
  async appendEvent(
    sessionId: string,
    parentId: string | null,
    event: AgentStreamEvent,
  ): Promise<string> {
    const id = randomUUID();
    await this.appendRecords(sessionId, [
      {
        kind: 'entry',
        id,
        parentId,
        type: 'event',
        event,
        createdAt: new Date().toISOString(),
      },
      { kind: 'leaf', entryId: id, createdAt: new Date().toISOString() },
    ]);
    return id;
  }

  /** 在同一 session 中切换 active leaf。 */
  async checkout(sessionId: string, entryId: string | null): Promise<void> {
    await this.appendRecords(sessionId, [
      { kind: 'leaf', entryId, createdAt: new Date().toISOString() },
    ]);
  }

  /** 从当前 active path fork 到一个新 session 文件。 */
  async fork(sessionId: string, reason = 'fork'): Promise<SessionInfo> {
    const source = await this.load(sessionId);
    const nextId = randomUUID();
    const createdAt = new Date().toISOString();
    const records: SessionRecord[] = [
      {
        kind: 'header',
        sessionId: nextId,
        cwd: source.info.cwd,
        createdAt,
        version: SESSION_FILE_VERSION,
      },
      ...source.records.filter(
        (record): record is Extract<SessionRecord, { kind: 'entry' }> =>
          record.kind === 'entry',
      ),
      { kind: 'leaf', entryId: source.leafEntryId, createdAt },
      {
        kind: 'branch',
        from: source.leafEntryId,
        to: nextId,
        reason,
        createdAt,
      },
    ];
    await writeFile(
      this.filePath(nextId),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );
    return (await this.load(nextId)).info;
  }

  /** 返回完整 session tree，供 /tree 和 TUI 时间线使用。 */
  async tree(sessionId: string): Promise<SessionTreeView> {
    const records = await this.readRecords(sessionId);
    const activeEntryId = findLeaf(records);
    const activePath = new Set(
      buildActivePath(records, activeEntryId)
        .filter((record) => record.kind === 'entry')
        .map((record) => record.id),
    );
    return {
      sessionId,
      activeEntryId,
      nodes: records
        .filter(
          (record): record is Extract<SessionRecord, { kind: 'entry' }> =>
            record.kind === 'entry',
        )
        .map((record) => ({
          id: record.id,
          parentId: record.parentId,
          type: record.type,
          label: labelEntry(record),
          createdAt: record.createdAt,
          active: activePath.has(record.id),
        })),
      branches: records
        .filter(
          (record): record is Extract<SessionRecord, { kind: 'branch' }> =>
            record.kind === 'branch',
        )
        .map(({ from, to, reason, createdAt }) => ({
          from,
          to,
          reason,
          createdAt,
        })),
      compactions: records
        .filter(
          (record): record is Extract<SessionRecord, { kind: 'compaction' }> =>
            record.kind === 'compaction',
        )
        .map((record) => ({
          id: record.id,
          ...(record.boundaryEntryId !== undefined
            ? { boundaryEntryId: record.boundaryEntryId }
            : {}),
          summary: record.summary,
          createdAt: record.createdAt,
        })),
    };
  }

  /** 追加 compact boundary。 */
  async compact(sessionId: string, summary: CompactSummary): Promise<void> {
    await this.appendRecords(sessionId, [
      {
        kind: 'compaction',
        id: summary.id,
        ...(summary.boundaryEntryId !== undefined
          ? { boundaryEntryId: summary.boundaryEntryId }
          : {}),
        summary: summary.summary,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  /** 读取最近一次 compact summary，作为后续 turn 的 sessionSummaryContext。 */
  async latestCompactionSummary(sessionId: string): Promise<string | null> {
    const records = await this.readRecords(sessionId);
    const latest = [...records]
      .reverse()
      .find(
        (record): record is Extract<SessionRecord, { kind: 'compaction' }> =>
          record.kind === 'compaction',
      );
    return latest?.summary ?? null;
  }

  /** 列出 session 文件摘要。 */
  async list(): Promise<JsonlSessionSummary[]> {
    await mkdir(this.options.sessionDir, { recursive: true });
    const files = (await readdir(this.options.sessionDir))
      .filter((file) => file.endsWith('.jsonl'))
      .sort();
    const summaries: JsonlSessionSummary[] = [];
    for (const file of files) {
      const fullPath = path.join(this.options.sessionDir, file);
      try {
        const records = await this.readRecords(path.basename(file, '.jsonl'));
        const header = records.find(
          (record): record is Extract<SessionRecord, { kind: 'header' }> =>
            record.kind === 'header',
        );
        const fileStat = await stat(fullPath);
        const preview = summarizeRecentMessages(records);
        summaries.push({
          sessionId: header?.sessionId ?? path.basename(file, '.jsonl'),
          path: fullPath,
          cwd: header?.cwd ?? this.options.cwd,
          entryCount: records.filter((record) => record.kind === 'entry')
            .length,
          ...(preview.lastUserText !== undefined
            ? { lastUserText: preview.lastUserText }
            : {}),
          ...(preview.lastAssistantText !== undefined
            ? { lastAssistantText: preview.lastAssistantText }
            : {}),
          ...(preview.lastToolText !== undefined
            ? { lastToolText: preview.lastToolText }
            : {}),
          ...(header?.createdAt !== undefined
            ? { createdAt: header.createdAt }
            : {}),
          updatedAt: fileStat.mtime.toISOString(),
        });
      } catch (error) {
        summaries.push({
          sessionId: path.basename(file, '.jsonl'),
          path: fullPath,
          cwd: this.options.cwd,
          entryCount: 0,
          updatedAt: `corrupt: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return summaries;
  }

  /** 导出原始 JSONL 内容。 */
  async exportJsonl(sessionId: string): Promise<string> {
    return readFile(this.filePath(sessionId), 'utf8');
  }

  /** 导出简单 HTML transcript，方便归档和人工检查。 */
  async exportHtml(sessionId: string): Promise<string> {
    const loaded = await this.load(sessionId);
    const body = loaded.records
      .map((record) => {
        if (record.kind !== 'entry') return '';
        return `<section data-entry="${escapeHtml(record.id)}"><h2>${escapeHtml(labelEntry(record))}</h2><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre></section>`;
      })
      .join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>ello session ${escapeHtml(sessionId)}</title></head><body>${body}</body></html>`;
  }

  private filePath(sessionId: string): string {
    return path.join(this.options.sessionDir, `${sessionId}.jsonl`);
  }

  private async appendRecords(
    sessionId: string,
    records: readonly SessionRecord[],
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    await appendFile(
      this.filePath(sessionId),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );
  }

  private async readRecords(sessionId: string): Promise<SessionRecord[]> {
    const text = await readFile(this.filePath(sessionId), 'utf8');
    return text
      .split(/\n+/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as SessionRecord;
        } catch (error) {
          throw new Error(
            `Invalid JSON in ${this.filePath(sessionId)} at line ${index + 1}: ${String(error)}`,
            { cause: error },
          );
        }
      });
  }
}

function labelEntry(record: Extract<SessionRecord, { kind: 'entry' }>): string {
  if (record.type === 'message') {
    const content = (record.message as { content?: unknown }).content;
    const text =
      typeof content === 'string' ? content : JSON.stringify(content);
    return `${record.message.role} ${text.slice(0, 80)}`;
  }
  return record.event.type;
}

function summarizeRecentMessages(records: readonly SessionRecord[]): {
  readonly lastUserText?: string;
  readonly lastAssistantText?: string;
  readonly lastToolText?: string;
} {
  let lastUserText: string | undefined;
  let lastAssistantText: string | undefined;
  let lastToolText: string | undefined;
  for (const record of records) {
    if (record.kind !== 'entry' || record.type !== 'message') {
      continue;
    }
    const content = (record.message as { content?: unknown }).content;
    const text =
      typeof content === 'string' ? content : JSON.stringify(content);
    if (record.message.role === 'user') {
      lastUserText = text;
    } else if (record.message.role === 'assistant') {
      lastAssistantText = text;
    } else if (record.message.role === 'tool') {
      lastToolText = text;
    }
  }
  return {
    ...(lastUserText !== undefined ? { lastUserText } : {}),
    ...(lastAssistantText !== undefined ? { lastAssistantText } : {}),
    ...(lastToolText !== undefined ? { lastToolText } : {}),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function findLeaf(records: readonly SessionRecord[]): string | null {
  const leaf = [...records]
    .reverse()
    .find(
      (record): record is Extract<SessionRecord, { kind: 'leaf' }> =>
        record.kind === 'leaf',
    );
  return leaf?.entryId ?? null;
}

function buildActivePath(
  records: readonly SessionRecord[],
  leaf: string | null,
): SessionRecord[] {
  if (leaf === null) {
    return records.filter((record) => record.kind === 'header');
  }
  const byId = new Map<string, Extract<SessionRecord, { kind: 'entry' }>>();
  for (const record of records) {
    if (record.kind === 'entry') {
      byId.set(record.id, record);
    }
  }
  const active: SessionRecord[] = [];
  let current: string | null = leaf;
  while (current !== null) {
    const record = byId.get(current);
    if (record === undefined) {
      throw new Error(`Invalid session tree: missing entry ${current}`);
    }
    active.push(record);
    current = record.parentId;
  }
  return active.reverse();
}
