import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  generateEntryId,
  type SessionEntry,
  type SessionStorage,
} from '@ello/agent';

interface JsonlSessionRecord {
  kind: 'metadata' | 'leaf' | 'entry' | 'event' | 'task_snapshot' | 'memory_manifest';
  value: unknown;
}

/**
 * Lightweight summary used by session picker and `ello sessions`.
 */
export interface JsonlSessionSummary {
  sessionId: string;
  filePath: string;
  createdAt: string | null;
  updatedAt: string | null;
  leafId: string | null;
  entryCount: number;
  branchOf: string | null;
}

/**
 * 用于会话历史、元数据、任务和记忆的追加式 JSONL 存储。
 */
export class JsonlSessionStorage implements SessionStorage {
  private readonly metadata: Record<string, unknown>;
  private readonly entries: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private latestTaskSnapshot: unknown = [];
  private leafId: string | null = null;

  constructor(
    readonly filePath: string,
    options: { sessionId: string; createdAt?: string } = { sessionId: '' },
  ) {
    this.metadata = {
      id: options.sessionId,
      createdAt: options.createdAt ?? new Date().toISOString(),
    };
  }

  /**
   * Open an existing JSONL session or initialize a new append-only file.
   */
  static async open(options: {
    sessionDir: string;
    sessionId: string;
  }): Promise<JsonlSessionStorage> {
    const store = new JsonlSessionStorage(
      path.join(options.sessionDir, `${options.sessionId}.jsonl`),
      { sessionId: options.sessionId },
    );
    await store.load();
    return store;
  }

  async getMetadata(): Promise<Record<string, unknown>> {
    return { ...this.metadata };
  }

  /**
   * 返回用于分支重建的当前对话叶子节点。
   */
  async getLeafId(): Promise<string | null> {
    return this.leafId;
  }

  /**
   * 在分支或手动恢复后移动活跃叶子节点指针。
   */
  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new Error(`Entry '${leafId}' not found`);
    }
    this.leafId = leafId;
    await this.appendRecord({ kind: 'leaf', value: leafId });
  }

  /**
   * 追加模型/会话条目，并推进活跃叶子节点指针。
   */
  async appendEntry(entry: SessionEntry): Promise<void> {
    if (!entry.id) {
      entry.id = generateEntryId();
    }
    if (!entry.timestamp) {
      entry.timestamp = new Date().toISOString();
    }
    if (entry.parentId === null) {
      entry.parentId = this.leafId;
    }
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    await this.appendRecord({ kind: 'entry', value: entry });
  }

  async getEntry(entryId: string): Promise<SessionEntry | null> {
    return this.byId.get(entryId) ?? null;
  }

  /**
   * 从叶子条目向会话根节点重建线性路径。
   */
  async getPathToRoot(leafId: string | null): Promise<SessionEntry[]> {
    if (leafId === null) {
      return [];
    }
    const result: SessionEntry[] = [];
    let current = this.byId.get(leafId);
    while (current !== undefined) {
      result.push(current);
      current = current.parentId === null ? undefined : this.byId.get(current.parentId);
    }
    return result.reverse();
  }

  async getEntries(): Promise<SessionEntry[]> {
    return [...this.entries];
  }

  /**
   * 返回从会话文件回放得到的最新任务快照。
   */
  getLatestTaskSnapshot(): unknown {
    return this.latestTaskSnapshot;
  }

  /**
   * 持久化分支信息、后续标签等元数据更新。
   */
  async updateMetadata(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.metadata, values);
    await this.appendRecord({ kind: 'metadata', value: this.metadata });
  }

  /**
   * Mark this session as a branch of another persisted session.
   */
  async branchFrom(parentSessionId: string, parentLeafId: string | null): Promise<void> {
    await this.updateMetadata({
      branchOf: parentSessionId,
      branchLeafId: parentLeafId,
      branchedAt: new Date().toISOString(),
    });
  }

  /**
   * 追加产品层事件，用于诊断和审计轨迹。
   */
  async appendEvent(event: Record<string, unknown>): Promise<void> {
    await this.appendRecord({
      kind: 'event',
      value: { ...event, timestamp: new Date().toISOString() },
    });
  }

  /**
   * 持久化最新任务快照，不重写旧的会话记录。
   */
  async appendTaskSnapshot(tasks: unknown): Promise<void> {
    await this.appendRecord({
      kind: 'task_snapshot',
      value: { tasks, timestamp: new Date().toISOString() },
    });
  }

  /**
   * 持久化当前会话加载的记忆清单。
   */
  async appendMemoryManifest(manifest: unknown): Promise<void> {
    await this.appendRecord({
      kind: 'memory_manifest',
      value: { manifest, timestamp: new Date().toISOString() },
    });
  }

  /**
   * 将追加式 JSONL 文件回放到内存索引中。
   */
  private async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await this.appendRecord({ kind: 'metadata', value: this.metadata });
      return;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const record = JSON.parse(line) as JsonlSessionRecord;
      if (record.kind === 'metadata' && isRecord(record.value)) {
        Object.assign(this.metadata, record.value);
      } else if (record.kind === 'leaf') {
        this.leafId = typeof record.value === 'string' ? record.value : null;
      } else if (record.kind === 'entry') {
        const entry = record.value as SessionEntry;
        this.entries.push(entry);
        this.byId.set(entry.id, entry);
        this.leafId = entry.id;
      } else if (record.kind === 'task_snapshot') {
        if (isRecord(record.value) && Array.isArray(record.value.tasks)) {
          this.latestTaskSnapshot = record.value.tasks;
        }
      }
    }
  }

  /**
   * 追加一条 JSONL 记录，并按需创建会话目录。
   */
  private async appendRecord(record: JsonlSessionRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
  }
}

/**
 * 从配置的会话目录列出已持久化的会话摘要。
 */
export async function listJsonlSessions(
  sessionDir: string,
): Promise<JsonlSessionSummary[]> {
  await mkdir(sessionDir, { recursive: true });
  const files = await readdir(sessionDir);
  const summaries = await Promise.all(
    files
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => readSessionSummary(path.join(sessionDir, file))),
  );
  return summaries.sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  );
}

async function readSessionSummary(filePath: string): Promise<JsonlSessionSummary> {
  const fallbackId = path.basename(filePath, '.jsonl');
  let metadata: Record<string, unknown> = {};
  let leafId: string | null = null;
  let entryCount = 0;
  let updatedAt: string | null = null;
  const content = await readFile(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const record = JSON.parse(line) as JsonlSessionRecord;
    if (record.kind === 'metadata' && isRecord(record.value)) {
      metadata = { ...metadata, ...record.value };
      updatedAt = typeof metadata.updatedAt === 'string' ? metadata.updatedAt : updatedAt;
    } else if (record.kind === 'leaf') {
      leafId = typeof record.value === 'string' ? record.value : null;
    } else if (record.kind === 'entry') {
      const entry = record.value as SessionEntry;
      entryCount += 1;
      leafId = entry.id;
      updatedAt = entry.timestamp || updatedAt;
    } else if (record.kind === 'event' || record.kind === 'task_snapshot') {
      if (isRecord(record.value) && typeof record.value.timestamp === 'string') {
        updatedAt = record.value.timestamp;
      }
    }
  }
  return {
    sessionId: typeof metadata.id === 'string' ? metadata.id : fallbackId,
    filePath,
    createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : null,
    updatedAt,
    leafId,
    entryCount,
    branchOf: typeof metadata.branchOf === 'string' ? metadata.branchOf : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
