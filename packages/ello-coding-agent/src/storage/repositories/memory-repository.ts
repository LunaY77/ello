import { randomUUID } from 'node:crypto';

import { asc, eq, isNull, and } from 'drizzle-orm';

import {
  closeCodingDatabase,
  openGlobalCodingDatabaseSync,
} from '../database.js';
import { memoryAccessLog, memoryItems } from '../schema.js';

export type MemoryKind = 'preference' | 'fact' | 'instruction' | 'summary';
export type MemorySource = 'manual' | 'learned' | 'import';

export interface MemoryItem {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly tags: readonly string[];
  readonly source: MemorySource;
  readonly confidence?: number | undefined;
  readonly enabled: boolean;
  readonly lastUsedAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string | undefined;
}

export interface CreateMemoryInput {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly tags?: readonly string[] | undefined;
  readonly source?: MemorySource | undefined;
  readonly confidence?: number | undefined;
  readonly enabled?: boolean | undefined;
}

/**
 * 全局结构化 memory 仓储。
 *
 * 它只处理用户显式录入或确认学习的长期事实/偏好；项目 `.ello/memory.md`、
 * `ELLO.md`、`AGENTS.md` 等 Markdown 仍然直接从文件读取，不在 DB 建索引缓存。
 */
export class MemoryRepository {
  private readonly ownsDb: boolean;

  constructor(private readonly db = openGlobalCodingDatabaseSync()) {
    this.ownsDb = arguments.length === 0;
  }

  async listEnabled(): Promise<readonly MemoryItem[]> {
    const rows = this.db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.enabled, 1), isNull(memoryItems.archivedAt)))
      .orderBy(asc(memoryItems.createdAt))
      .all();
    return rows.map(normalizeMemoryItem);
  }

  async createManual(input: Omit<CreateMemoryInput, 'source'>): Promise<MemoryItem> {
    return this.create({ ...input, source: 'manual' });
  }

  async recordLearned(input: Omit<CreateMemoryInput, 'source'>): Promise<MemoryItem> {
    return this.create({ ...input, source: 'learned' });
  }

  async create(input: CreateMemoryInput): Promise<MemoryItem> {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      kind: input.kind,
      content: input.content,
      tags: JSON.stringify([...(input.tags ?? [])]),
      source: input.source ?? 'manual',
      confidence: input.confidence ?? null,
      enabled: input.enabled === false ? 0 : 1,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.db.insert(memoryItems).values(row).run();
    return normalizeMemoryItem(row);
  }

  async markUsed(
    id: string,
    input: { readonly runId?: string | undefined; readonly usedFor: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .update(memoryItems)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(memoryItems.id, id))
      .run();
    this.db
      .insert(memoryAccessLog)
      .values({
        id: randomUUID(),
        memoryItemId: id,
        runId: input.runId ?? null,
        usedFor: input.usedFor,
        createdAt: now,
      })
      .run();
  }

  close(): void {
    if (this.ownsDb) {
      closeCodingDatabase(this.db);
    }
  }
}

function normalizeMemoryItem(
  row: typeof memoryItems.$inferSelect | typeof memoryItems.$inferInsert,
): MemoryItem {
  const tags = safeJsonArray(row.tags ?? '[]');
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    content: row.content,
    tags,
    source: row.source as MemorySource,
    ...(row.confidence !== null && row.confidence !== undefined
      ? { confidence: row.confidence }
      : {}),
    enabled: row.enabled === 1,
    ...(row.lastUsedAt !== null && row.lastUsedAt !== undefined
      ? { lastUsedAt: row.lastUsedAt }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.archivedAt !== null && row.archivedAt !== undefined
      ? { archivedAt: row.archivedAt }
      : {}),
  };
}

function safeJsonArray(text: string): readonly string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}
