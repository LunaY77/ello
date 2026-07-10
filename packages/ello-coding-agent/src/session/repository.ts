import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { AgentFinishReason, AgentMessage, AgentUsage } from '@ello/agent';

import { SessionCatalog, type SessionCatalogRecord } from './catalog.js';
import { parseSessionRecord } from './schema.js';

/** JSONL session 文件版本。 */
export const SESSION_FILE_VERSION = 3;

/** 一个会话文件的元信息。 */
export interface SessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly path: string;
  readonly createdAt: string;
  readonly title?: string;
  readonly activeEntryId?: string;
}

/** append-only session tree 的记录形状。 */
export type SessionRecord =
  | {
      readonly kind: 'header';
      readonly sessionId: string;
      readonly cwd: string;
      readonly createdAt: string;
      readonly version: typeof SESSION_FILE_VERSION;
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
      readonly kind: 'run-marker';
      readonly runId: string;
      readonly status: 'started';
      readonly createdAt: string;
    }
  | {
      readonly kind: 'run-marker';
      readonly runId: string;
      readonly status: 'completed';
      readonly finishReason: AgentFinishReason;
      readonly usage: AgentUsage;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'run-marker';
      readonly runId: string;
      readonly status: 'failed';
      readonly error: { readonly name: string; readonly message: string };
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
      readonly kind: 'session-title';
      readonly title: string;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'compaction';
      readonly id: string;
      /**
       * compaction 是 active path 上的真实节点，挂在压缩时的 leaf 之下，
       * 参与 `buildActivePath` 回溯。删除它会让投影失效。
       */
      readonly parentId: string | null;
      /**
       * 投影起点：从该 entry 起的 kept 消息进入模型视图，之前的消息被 summary 取代。
       * 同样参与投影，不能当作可丢弃的元数据。
       */
      readonly firstKeptEntryId: string;
      /** checkpoint 正文。 */
      readonly summary: string;
      /** 投影前上下文 token 估算，用于诊断与 TUI。 */
      readonly tokensBefore: number;
      /**
       * 机器可用的累计文件清单，跨多次压缩继承；与 summary 正文里的
       * `<read-files>`/`<modified-files>` 双写，正文给模型、details 给机器/TUI。
       */
      readonly details?: {
        readonly readFiles?: readonly string[];
        readonly modifiedFiles?: readonly string[];
      };
      readonly createdAt: string;
    }
  | {
      /**
       * 大 tool 输出的预算替换决策。按 toolCallId 记录，latest-wins；
       * 不参与 active path 回溯，但在投影模型视图时把对应 tool result 换成 stub。
       */
      readonly kind: 'content-replacement';
      readonly toolCallId: string;
      readonly artifactId: string;
      readonly preview: string;
      readonly originalBytes: number;
      readonly sha256: string;
      readonly createdAt: string;
    }
  | {
      /**
       * 手动 `/summary` 纪要：旁路记录，latest-wins，不带 parentId、
       * 不进 `buildActivePath`、不影响 modelMessages。纯人类 deliverable。
       */
      readonly kind: 'session-summary';
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
  readonly title?: string;
  readonly lastUserText?: string;
  readonly lastAssistantText?: string;
  readonly lastToolText?: string;
}

/** active path 的读取结果。 */
export interface ActiveSessionPath {
  readonly info: SessionInfo;
  readonly records: SessionRecord[];
  /** raw 视图：active path 上全部 message（TUI 历史/fork/export 用，保真）。 */
  readonly messages: AgentMessage[];
  /** raw message 的来源 entry id（与 messages 平行，供 TUI 定位/选中）。 */
  readonly messageEntryIds: string[];
  /** 模型视图：投影后的 [summary, ...kept, ...after]（store.load 返回它）。 */
  readonly modelMessages: AgentMessage[];
  readonly replacements: ReadonlyMap<string, ContentReplacementRecord>;
  readonly leafEntryId: string | null;
}

export type ContentReplacementRecord = Extract<
  SessionRecord,
  { kind: 'content-replacement' }
>;

/** raw active path 上可供 TUI 导航的 message entry。 */
export interface SessionMessageEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly message: AgentMessage;
}

/** TUI/RPC 使用的 session tree 节点。 */
export interface SessionTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: 'message';
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
    readonly parentId: string | null;
    readonly firstKeptEntryId: string;
    readonly summary: string;
    readonly tokensBefore: number;
    readonly active: boolean;
    readonly createdAt: string;
  }>;
}

/** 追加一个 compaction 节点所需的输入。 */
export interface AppendCompactionInput {
  readonly parentId: string | null;
  readonly firstKeptEntryId: string;
  readonly summary: string;
  readonly tokensBefore: number;
  readonly details?: {
    readonly readFiles?: readonly string[];
    readonly modifiedFiles?: readonly string[];
  };
}

/** 上一次 compaction 的可读视图，供 compact 迭代 seed 与累计文件清单。 */
export interface CompactionRef {
  readonly firstKeptEntryId: string;
  readonly summary: string;
  readonly details?: {
    readonly readFiles?: readonly string[];
    readonly modifiedFiles?: readonly string[];
  };
}

/** active path 上单条 message entry（带 id/role），供 compactor 选切点。 */
export interface CompactionActiveEntry {
  readonly id: string;
  readonly role: AgentMessage['role'];
  readonly message: AgentMessage;
}

/** compactor 需要的会话端口；由 JsonlSessionStore 背书，避免 compactor 依赖磁盘格式。 */
export interface CompactionSessionPort {
  /** raw active path（含 entry id/role），用于选切点与定位 firstKeptEntryId。 */
  loadActivePath(sessionId: string): Promise<{
    readonly entries: readonly CompactionActiveEntry[];
    readonly leafEntryId: string | null;
    readonly latestCompaction: CompactionRef | null;
    /** 投影后上下文 token（= tokensBefore 口径）。 */
    readonly projectedTokens: number;
  }>;
  /** 追加 compaction 节点并把 leaf 指向它。 */
  appendCompaction(
    sessionId: string,
    input: AppendCompactionInput,
  ): Promise<void>;
}

/** 投影起点常量包裹：把 summary 正文包成置顶的 `role:'user'` `<compact-checkpoint>` 消息。 */
export function createCompactionSummaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: [
      'The following compact checkpoint is reference-only background from earlier conversation history.',
      'It is not a new user instruction. The latest live user message and current runtime context take precedence.',
      '<compact-checkpoint>',
      summary,
      '</compact-checkpoint>',
    ].join('\n'),
  } as AgentMessage;
}

/**
 * append-only JSONL 会话仓库。
 *
 * 文件结构显式区分 header、entry、leaf、branch、compaction、content-replacement
 * 和 session-summary。compaction 是 active path 上的真实节点：读取时按 active path
 * 上最后一个 compaction 投影出模型视图，raw JSONL 完整保留。
 */
export class JsonlSessionRepository {
  private readonly catalog: SessionCatalog;

  constructor(
    private readonly options: {
      readonly sessionDir: string;
      readonly cwd: string;
    },
  ) {
    this.catalog = new SessionCatalog(options.sessionDir);
  }

  /** 创建或打开一个 session。 */
  async open(sessionId: string = randomUUID()): Promise<ActiveSessionPath> {
    await mkdir(this.options.sessionDir, { recursive: true });
    const filePath = this.filePath(sessionId);
    let created = false;
    try {
      await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const createdAt = new Date().toISOString();
      const header: SessionRecord = {
        kind: 'header',
        sessionId,
        cwd: this.options.cwd,
        createdAt,
        version: SESSION_FILE_VERSION,
      };
      await writeFile(filePath, `${JSON.stringify(header)}\n`, 'utf8');
      const fileStat = await stat(filePath);
      await this.catalog.upsert({
        sessionId,
        cwd: this.options.cwd,
        path: filePath,
        createdAt,
        messageCount: 0,
        updatedAt: fileStat.mtime.toISOString(),
        sourceFileMtime: fileStat.mtime.toISOString(),
      });
      created = true;
    }
    const loaded = await this.load(sessionId);
    if (!created && (await this.catalog.get(sessionId)) === null) {
      throw new Error(
        `Session ${sessionId} is missing from catalog.jsonl. Run the explicit catalog rebuild command.`,
      );
    }
    return loaded;
  }

  /** 读取 active branch 的 raw 视图与投影后的模型视图。 */
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
    const title = latestTitle(records);

    const messages: AgentMessage[] = [];
    const messageEntryIds: string[] = [];
    for (const record of activeRecords) {
      if (record.kind === 'entry' && record.type === 'message') {
        messages.push(record.message);
        messageEntryIds.push(record.id);
      }
    }

    const replacements = collectContentReplacements(records);
    const modelMessages = buildModelMessages(activeRecords, replacements);

    return {
      info: {
        sessionId: header.sessionId,
        cwd: header.cwd,
        path: this.filePath(sessionId),
        createdAt: header.createdAt,
        ...(title !== undefined ? { title } : {}),
        ...(leaf !== null ? { activeEntryId: leaf } : {}),
      },
      records: activeRecords,
      messages,
      messageEntryIds,
      modelMessages,
      replacements,
      leafEntryId: leaf,
    };
  }

  /** 读取指定历史 leaf 对应的 raw message path，供 durable memory job 恢复。 */
  async loadMessagesAt(
    sessionId: string,
    leafEntryId: string,
  ): Promise<readonly AgentMessage[]> {
    const records = await this.readRecords(sessionId);
    const entry = records.find(
      (record): record is Extract<SessionRecord, { kind: 'entry' }> =>
        record.kind === 'entry' && record.id === leafEntryId,
    );
    if (entry === undefined) {
      throw new Error(
        `Unknown memory extraction leaf ${leafEntryId} in session ${sessionId}.`,
      );
    }
    return buildActivePath(records, leafEntryId)
      .filter(
        (record): record is Extract<SessionRecord, { kind: 'entry' }> =>
          record.kind === 'entry' && record.type === 'message',
      )
      .map((record) => record.message);
  }

  /** 追加消息增量。 */
  async appendMessages(
    sessionId: string,
    parentId: string | null,
    messages: readonly AgentMessage[],
  ): Promise<string | null> {
    const catalog = await this.requireCatalogRecord(sessionId);
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
      const fileStat = await stat(this.filePath(sessionId));
      await this.catalog.recordMessages(
        catalog,
        messages,
        fileStat.mtime.toISOString(),
      );
    }
    return leaf;
  }

  async appendRunMarker(
    sessionId: string,
    marker:
      | { readonly runId: string; readonly status: 'started' }
      | {
          readonly runId: string;
          readonly status: 'completed';
          readonly finishReason: AgentFinishReason;
          readonly usage: AgentUsage;
        }
      | {
          readonly runId: string;
          readonly status: 'failed';
          readonly error: { readonly name: string; readonly message: string };
        },
  ): Promise<void> {
    await this.appendRecords(sessionId, [
      {
        kind: 'run-marker',
        ...marker,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  /** 在同一 session 中切换 active leaf。 */
  async checkout(sessionId: string, entryId: string | null): Promise<void> {
    await this.appendRecords(sessionId, [
      { kind: 'leaf', entryId, createdAt: new Date().toISOString() },
    ]);
  }

  /** 读取 active path 上的 raw message entry，保留 entry id 与 parentId。 */
  async messageEntries(
    sessionId: string,
  ): Promise<readonly SessionMessageEntry[]> {
    const loaded = await this.load(sessionId);
    return loaded.records.flatMap((record) =>
      record.kind === 'entry' && record.type === 'message'
        ? [
            {
              id: record.id,
              parentId: record.parentId,
              message: record.message,
            },
          ]
        : [],
    );
  }

  /** 返回 active path 上某 message entry 的父节点，用于 rewind 到该 user 之前。 */
  async parentOfMessageEntry(
    sessionId: string,
    entryId: string,
  ): Promise<string | null> {
    const entry = await this.resolveMessageEntry(sessionId, entryId);
    if (entry === undefined) {
      throw new Error(`Unknown message entry: ${entryId}`);
    }
    return entry.parentId;
  }

  /** 按完整 id 或唯一前缀解析 active path 上的 message entry。 */
  async resolveMessageEntry(
    sessionId: string,
    idOrPrefix: string,
  ): Promise<SessionMessageEntry> {
    const matches = (await this.messageEntries(sessionId)).filter((entry) =>
      entry.id.startsWith(idOrPrefix),
    );
    if (matches.length === 0) {
      throw new Error(`Unknown message entry: ${idOrPrefix}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous message entry prefix: ${idOrPrefix}`);
    }
    return matches[0]!;
  }

  /**
   * 从当前 active path fork 到一个新 session 文件。
   *
   * 复制 active path 上的 entry **与 compaction 节点**（保留其
   * `parentId`/`firstKeptEntryId`），否则 fork 后投影会失效（§1.8）。
   * 传 `targetEntryId` 则只复制 root→targetEntryId 的前缀（§3.1）。
   */
  async fork(
    sessionId: string,
    options: { readonly reason?: string; readonly targetEntryId?: string } = {},
  ): Promise<SessionInfo> {
    const reason = options.reason ?? 'fork';
    const source = await this.load(sessionId);
    if (source.messages.length === 0) {
      throw new Error('Cannot fork an empty session.');
    }
    const target = options.targetEntryId ?? source.leafEntryId;
    // 沿 active path 截取 root→target 的前缀（含 entry 与 compaction 节点）。
    const prefix = takePrefix(source.records, target);
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
      ...prefix.filter(
        (record): record is Extract<SessionRecord, { kind: 'entry' }> =>
          record.kind === 'entry',
      ),
      ...prefix.filter(
        (record): record is Extract<SessionRecord, { kind: 'compaction' }> =>
          record.kind === 'compaction',
      ),
      ...source.replacements.values(),
      ...(source.info.title !== undefined
        ? [
            {
              kind: 'session-title' as const,
              title: source.info.title,
              createdAt,
            },
          ]
        : []),
      { kind: 'leaf', entryId: target, createdAt },
      {
        kind: 'branch',
        from: target,
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
    const fileStat = await stat(this.filePath(nextId));
    const summary = summarizeRecentMessages(records);
    await this.catalog.upsert({
      sessionId: nextId,
      cwd: source.info.cwd,
      path: this.filePath(nextId),
      createdAt,
      messageCount: records.filter((record) => record.kind === 'entry').length,
      ...(source.info.title !== undefined ? { title: source.info.title } : {}),
      ...summary,
      updatedAt: fileStat.mtime.toISOString(),
      sourceFileMtime: fileStat.mtime.toISOString(),
    });
    return (await this.load(nextId)).info;
  }

  /** 返回完整 session tree，供 fork/checkout/export 等底层会话能力使用。 */
  async tree(sessionId: string): Promise<SessionTreeView> {
    const records = await this.readRecords(sessionId);
    const activeEntryId = findLeaf(records);
    const activePath = new Set(
      buildActivePath(records, activeEntryId).map((record) =>
        record.kind === 'entry' || record.kind === 'compaction'
          ? record.id
          : '',
      ),
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
          parentId: record.parentId,
          firstKeptEntryId: record.firstKeptEntryId,
          summary: record.summary,
          tokensBefore: record.tokensBefore,
          active: activePath.has(record.id),
          createdAt: record.createdAt,
        })),
    };
  }

  /**
   * 追加一个 compaction 节点并把 leaf 指向它。
   *
   * 追加 compaction 节点并把 leaf 指向它。raw 历史完整保留，
   * 模型视图在 `load()` 时按 `firstKeptEntryId` 投影。
   * 返回新 leaf（= compaction 节点 id），便于调用方刷新 leaf 缓存。
   */
  async appendCompaction(
    sessionId: string,
    input: AppendCompactionInput,
  ): Promise<string> {
    const id = randomUUID();
    await this.appendRecords(sessionId, [
      {
        kind: 'compaction',
        id,
        parentId: input.parentId,
        firstKeptEntryId: input.firstKeptEntryId,
        summary: input.summary,
        tokensBefore: input.tokensBefore,
        ...(input.details !== undefined ? { details: input.details } : {}),
        createdAt: new Date().toISOString(),
      },
      { kind: 'leaf', entryId: id, createdAt: new Date().toISOString() },
    ]);
    return id;
  }

  /** 追加一条大 tool 输出替换记录（§2）。latest-wins，不动 leaf。 */
  async appendContentReplacement(
    sessionId: string,
    input: {
      readonly toolCallId: string;
      readonly artifactId: string;
      readonly preview: string;
      readonly originalBytes: number;
      readonly sha256: string;
    },
  ): Promise<void> {
    await this.appendRecords(sessionId, [
      {
        kind: 'content-replacement',
        toolCallId: input.toolCallId,
        artifactId: input.artifactId,
        preview: input.preview,
        originalBytes: input.originalBytes,
        sha256: input.sha256,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  /** 持久化 session 标题。 */
  async setTitle(sessionId: string, title: string): Promise<void> {
    const normalized = normalizeTitle(title);
    if (!normalized) {
      return;
    }
    const catalog = await this.requireCatalogRecord(sessionId);
    await this.appendRecords(sessionId, [
      {
        kind: 'session-title',
        title: normalized,
        createdAt: new Date().toISOString(),
      },
    ]);
    const fileStat = await stat(this.filePath(sessionId));
    await this.catalog.upsert({
      ...catalog,
      title: normalized,
      updatedAt: fileStat.mtime.toISOString(),
      sourceFileMtime: fileStat.mtime.toISOString(),
    });
  }

  /** 读取最新 session 标题。 */
  async title(sessionId: string): Promise<string | null> {
    return latestTitle(await this.readRecords(sessionId)) ?? null;
  }

  /** 追加一条手动 `/summary` 纪要（§4.2）。旁路记录，不进 active path。 */
  async appendSummary(sessionId: string, summary: string): Promise<void> {
    const trimmed = summary.trim();
    if (!trimmed) {
      return;
    }
    await this.appendRecords(sessionId, [
      {
        kind: 'session-summary',
        summary: trimmed,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  /** 读取最近一次手动 `/summary` 纪要（仅供 `/summary` 迭代自己的 seed）。 */
  async latestSummary(sessionId: string): Promise<{ summary: string } | null> {
    const latest = [...(await this.readRecords(sessionId))]
      .reverse()
      .find(
        (
          record,
        ): record is Extract<SessionRecord, { kind: 'session-summary' }> =>
          record.kind === 'session-summary',
      );
    return latest !== undefined ? { summary: latest.summary } : null;
  }

  /** 读取 active path 上最近一次 compaction，供 compact 迭代 seed 与累计文件清单。 */
  async latestCompaction(sessionId: string): Promise<CompactionRef | null> {
    const records = await this.readRecords(sessionId);
    const leaf = findLeaf(records);
    const activePath = buildActivePath(records, leaf);
    const latest = [...activePath]
      .reverse()
      .find(
        (record): record is Extract<SessionRecord, { kind: 'compaction' }> =>
          record.kind === 'compaction',
      );
    if (latest === undefined) {
      return null;
    }
    return {
      firstKeptEntryId: latest.firstKeptEntryId,
      summary: latest.summary,
      ...(latest.details !== undefined ? { details: latest.details } : {}),
    };
  }

  /** compactor 端口实现：raw active path 的 message entry + 最近 compaction + 投影 token。 */
  async loadActivePathForCompaction(sessionId: string): Promise<{
    readonly entries: readonly CompactionActiveEntry[];
    readonly leafEntryId: string | null;
    readonly latestCompaction: CompactionRef | null;
    readonly projectedTokens: number;
  }> {
    const records = await this.readRecords(sessionId);
    const leaf = findLeaf(records);
    const activePath = buildActivePath(records, leaf);
    const entries: CompactionActiveEntry[] = [];
    for (const record of activePath) {
      if (record.kind === 'entry' && record.type === 'message') {
        entries.push({
          id: record.id,
          role: record.message.role,
          message: record.message,
        });
      }
    }
    const latest = [...activePath]
      .reverse()
      .find(
        (record): record is Extract<SessionRecord, { kind: 'compaction' }> =>
          record.kind === 'compaction',
      );
    const replacements = collectContentReplacements(records);
    const modelMessages = buildModelMessages(activePath, replacements);
    return {
      entries,
      leafEntryId: leaf,
      latestCompaction:
        latest !== undefined
          ? {
              firstKeptEntryId: latest.firstKeptEntryId,
              summary: latest.summary,
              ...(latest.details !== undefined
                ? { details: latest.details }
                : {}),
            }
          : null,
      projectedTokens: estimateMessagesTokens(modelMessages),
    };
  }

  /** 只读 catalog 列出 session，不打开 transcript 文件。 */
  async list(): Promise<JsonlSessionSummary[]> {
    return (await this.catalog.list()).map(catalogToSummary);
  }

  /** 显式扫描所有 v3 transcript 并重建 catalog。 */
  async rebuildCatalog(): Promise<number> {
    await mkdir(this.options.sessionDir, { recursive: true });
    const sessionIds = (await readdir(this.options.sessionDir))
      .filter((file) => file.endsWith('.jsonl') && file !== 'catalog.jsonl')
      .map((file) => path.basename(file, '.jsonl'))
      .sort();
    const catalogRecords: SessionCatalogRecord[] = [];
    for (const sessionId of sessionIds) {
      const records = await this.readRecords(sessionId);
      const header = requireHeader(records, sessionId);
      const fileStat = await stat(this.filePath(sessionId));
      const preview = summarizeRecentMessages(records);
      const title = latestTitle(records);
      catalogRecords.push({
        sessionId: header.sessionId,
        cwd: header.cwd,
        path: this.filePath(sessionId),
        createdAt: header.createdAt,
        messageCount: records.filter((record) => record.kind === 'entry')
          .length,
        ...(title !== undefined ? { title } : {}),
        ...preview,
        updatedAt: fileStat.mtime.toISOString(),
        sourceFileMtime: fileStat.mtime.toISOString(),
      });
    }
    await this.catalog.replace(catalogRecords);
    return catalogRecords.length;
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
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `Invalid JSON in ${this.filePath(sessionId)} at line ${index + 1}: ${String(error)}`,
            { cause: error },
          );
        }
        return parseSessionRecord(
          record,
          `${this.filePath(sessionId)}:${index + 1}`,
        );
      });
  }

  private async requireCatalogRecord(
    sessionId: string,
  ): Promise<SessionCatalogRecord> {
    const record = await this.catalog.get(sessionId);
    if (record === null) {
      throw new Error(
        `Session ${sessionId} is missing from catalog.jsonl. Run the explicit catalog rebuild command.`,
      );
    }
    return record;
  }
}

/** 节点 id（entry / compaction 都有 id）。 */
type NodeRecord =
  | Extract<SessionRecord, { kind: 'entry' }>
  | Extract<SessionRecord, { kind: 'compaction' }>;

function isNode(record: SessionRecord): record is NodeRecord {
  return record.kind === 'entry' || record.kind === 'compaction';
}

function labelEntry(record: Extract<SessionRecord, { kind: 'entry' }>): string {
  const content = (record.message as { content?: unknown }).content;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return `${record.message.role} ${text.slice(0, 80)}`;
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

function latestTitle(records: readonly SessionRecord[]): string | undefined {
  const latest = [...records]
    .reverse()
    .find(
      (record): record is Extract<SessionRecord, { kind: 'session-title' }> =>
        record.kind === 'session-title',
    );
  return latest?.title;
}

function requireHeader(
  records: readonly SessionRecord[],
  sessionId: string,
): Extract<SessionRecord, { kind: 'header' }> {
  const header = records.find(
    (record): record is Extract<SessionRecord, { kind: 'header' }> =>
      record.kind === 'header',
  );
  if (header === undefined) {
    throw new Error(`Invalid session ${sessionId}: missing header`);
  }
  return header;
}

function normalizeTitle(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .slice(0, 80);
}

function catalogToSummary(record: SessionCatalogRecord): JsonlSessionSummary {
  return {
    sessionId: record.sessionId,
    path: record.path,
    cwd: record.cwd,
    entryCount: record.messageCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.lastUserText !== undefined
      ? { lastUserText: record.lastUserText }
      : {}),
    ...(record.lastAssistantText !== undefined
      ? { lastAssistantText: record.lastAssistantText }
      : {}),
    ...(record.lastToolText !== undefined
      ? { lastToolText: record.lastToolText }
      : {}),
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

/**
 * 沿 `parentId` 从 leaf 回溯出 active path（root→leaf）。
 *
 * entry 与 compaction 节点都参与回溯（都有 id/parentId）；compaction 节点
 * 也会出现在返回序列里，供投影定位 firstKeptEntryId。
 */
function buildActivePath(
  records: readonly SessionRecord[],
  leaf: string | null,
): SessionRecord[] {
  if (leaf === null) {
    return records.filter((record) => record.kind === 'header');
  }
  const byId = new Map<string, NodeRecord>();
  for (const record of records) {
    if (isNode(record)) {
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

/** 收集所有 content-replacement，按 toolCallId latest-wins。 */
export function collectContentReplacements(
  records: readonly SessionRecord[],
): Map<string, ContentReplacementRecord> {
  const map = new Map<string, ContentReplacementRecord>();
  for (const record of records) {
    if (record.kind === 'content-replacement') {
      map.set(record.toolCallId, record);
    }
  }
  return map;
}

/**
 * 投影模型视图。
 *
 * active path 上若有 compaction，取最后一个：返回
 * `[summary, ...从 firstKeptEntryId 起的 message]`；否则返回全部 message。
 * 投影后再对 tool result 应用 content-replacement（§2）。
 */
function buildModelMessages(
  activePath: readonly SessionRecord[],
  replacements: ReadonlyMap<
    string,
    Extract<SessionRecord, { kind: 'content-replacement' }>
  >,
): AgentMessage[] {
  const lastCompactionIndex = findLastIndex(
    activePath,
    (record) => record.kind === 'compaction',
  );

  let projected: AgentMessage[];
  if (lastCompactionIndex < 0) {
    projected = activePath.flatMap((record) =>
      record.kind === 'entry' && record.type === 'message'
        ? [record.message]
        : [],
    );
  } else {
    const compaction = activePath[lastCompactionIndex] as Extract<
      SessionRecord,
      { kind: 'compaction' }
    >;
    const firstKeptIndex = activePath.findIndex(
      (record) => isNode(record) && record.id === compaction.firstKeptEntryId,
    );
    const keptStart = firstKeptIndex < 0 ? activePath.length : firstKeptIndex;
    const kept = activePath
      .slice(keptStart)
      .flatMap((record) =>
        record.kind === 'entry' && record.type === 'message'
          ? [record.message]
          : [],
      );
    projected = [createCompactionSummaryMessage(compaction.summary), ...kept];
  }

  return replacements.size > 0
    ? applyReplacementMap(projected, replacements)
    : projected;
}

/** 把投影消息里被替换的 tool result 换成 preview + artifact 指针 stub。 */
export function applyReplacementMap(
  messages: readonly AgentMessage[],
  replacements: ReadonlyMap<string, ContentReplacementRecord>,
): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return message;
    }
    let changed = false;
    const nextContent = content.map((part) => {
      const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId !== 'string') {
        return part;
      }
      const replacement = replacements.get(toolCallId);
      if (replacement === undefined) {
        return part;
      }
      changed = true;
      const stub = `${replacement.preview}\n\n<tool-output-truncated artifact-id="${replacement.artifactId}" sha256="${replacement.sha256}" bytes="${replacement.originalBytes}" />`;
      return {
        ...(part as Record<string, unknown>),
        output: { type: 'text', value: stub },
      };
    });
    return changed
      ? ({ ...message, content: nextContent } as unknown as AgentMessage)
      : message;
  });
}

/** 沿 active path 截取 root→target 的前缀（含 entry 与 compaction 节点）。 */
function takePrefix(
  activePath: readonly SessionRecord[],
  target: string | null,
): SessionRecord[] {
  if (target === null) {
    return [];
  }
  const result: SessionRecord[] = [];
  for (const record of activePath) {
    result.push(record);
    if (isNode(record) && record.id === target) {
      break;
    }
  }
  return result;
}

/** 估算消息序列 token（`ceil(chars/4)`），用于投影后触发判定。 */
function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    chars +=
      typeof content === 'string'
        ? content.length
        : JSON.stringify(content ?? '').length;
  }
  return Math.ceil(chars / 4);
}

/** Array.prototype.findLastIndex 的本地实现，避免 lib 版本依赖。 */
function findLastIndex<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) {
      return i;
    }
  }
  return -1;
}
