import { randomUUID } from 'node:crypto';

import type { AgentFinishReason, AgentUsage } from '@ello/agent';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';

import {
  closeCodingDatabase,
  openGlobalCodingDatabaseSync,
} from '../database.js';
import { usagePriceSnapshots, usageRecords } from '../schema.js';

export type UsageInvocation = 'tui' | 'run' | 'tool' | 'test' | 'unknown';
export type UsageStatus = 'completed' | 'failed' | 'interrupted';
export type UsageGroupBy = 'day' | 'model' | 'status';

export interface RecordUsageInput {
  readonly runId?: string | undefined;
  readonly invocation: UsageInvocation;
  readonly provider?: string | undefined;
  readonly model: string;
  readonly status: UsageStatus;
  readonly finishReason?: AgentFinishReason | string | undefined;
  readonly usage?: AgentUsage | undefined;
  readonly estimatedCostUsd?: number | undefined;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
}

export interface UsageFilter {
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly model?: string | undefined;
  readonly status?: UsageStatus | undefined;
}

export interface UsageRecord {
  readonly id: string;
  readonly runId?: string | undefined;
  readonly invocation: UsageInvocation;
  readonly provider?: string | undefined;
  readonly model: string;
  readonly status: UsageStatus;
  readonly finishReason?: string | undefined;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly toolCalls: number;
  readonly estimatedCostUsd?: number | undefined;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly createdAt: string;
}

export interface UsageSummaryRow {
  readonly key: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly toolCalls: number;
  readonly estimatedCostUsd: number;
  readonly runs: number;
}

export interface PriceSnapshotInput {
  readonly provider: string;
  readonly model: string;
  readonly inputUsdPer1m?: number | undefined;
  readonly outputUsdPer1m?: number | undefined;
  readonly cacheReadUsdPer1m?: number | undefined;
  readonly cacheWriteUsdPer1m?: number | undefined;
  readonly source?: string | undefined;
  readonly effectiveAt?: string | undefined;
}

/**
 * usage/cost 仓储。
 *
 * 只保存安全聚合字段：模型、状态、token、估算成本。prompt、completion、工具参数、
 * 工具结果和 session 内容都不进入 SQLite。
 */
export class UsageRepository {
  private readonly ownsDb: boolean;

  constructor(private readonly db = openGlobalCodingDatabaseSync()) {
    this.ownsDb = arguments.length === 0;
  }

  async recordUsage(input: RecordUsageInput): Promise<UsageRecord> {
    const now = new Date().toISOString();
    const usage = input.usage ?? zeroUsage();
    const row = {
      id: randomUUID(),
      runId: input.runId ?? null,
      invocation: input.invocation,
      provider: input.provider ?? null,
      model: input.model,
      status: input.status,
      finishReason: input.finishReason ?? null,
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      toolCalls: usage.toolCalls,
      estimatedCostUsd: input.estimatedCostUsd ?? null,
      startedAt: input.startedAt ?? now,
      completedAt: input.completedAt ?? now,
      createdAt: now,
    };
    this.db.insert(usageRecords).values(row).run();
    return normalizeUsageRecord(row);
  }

  async listRecords(filter: UsageFilter = {}): Promise<readonly UsageRecord[]> {
    const rows = this.db
      .select()
      .from(usageRecords)
      .where(buildUsageFilter(filter))
      .orderBy(desc(usageRecords.startedAt))
      .all();
    return rows.map(normalizeUsageRecord);
  }

  async summarize(
    filter: UsageFilter = {},
    groupBy: UsageGroupBy = 'model',
  ): Promise<readonly UsageSummaryRow[]> {
    const keyExpr =
      groupBy === 'day'
        ? sql<string>`substr(${usageRecords.startedAt}, 1, 10)`
        : groupBy === 'status'
          ? usageRecords.status
          : usageRecords.model;
    const rows = this.db
      .select({
        key: keyExpr,
        requests: sql<number>`coalesce(sum(${usageRecords.requests}), 0)`,
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${usageRecords.cacheWriteTokens}), 0)`,
        toolCalls: sql<number>`coalesce(sum(${usageRecords.toolCalls}), 0)`,
        estimatedCostUsd: sql<number>`coalesce(sum(${usageRecords.estimatedCostUsd}), 0)`,
        runs: sql<number>`count(*)`,
      })
      .from(usageRecords)
      .where(buildUsageFilter(filter))
      .groupBy(keyExpr)
      .orderBy(asc(keyExpr))
      .all();
    return rows.map((row) => ({
      key: row.key,
      requests: Number(row.requests),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheReadTokens: Number(row.cacheReadTokens),
      cacheWriteTokens: Number(row.cacheWriteTokens),
      toolCalls: Number(row.toolCalls),
      estimatedCostUsd: Number(row.estimatedCostUsd),
      runs: Number(row.runs),
    }));
  }

  async upsertPriceSnapshot(input: PriceSnapshotInput): Promise<string> {
    const now = new Date().toISOString();
    const id = `${input.provider}:${input.model}:${input.effectiveAt ?? now}`;
    this.db
      .insert(usagePriceSnapshots)
      .values({
        id,
        provider: input.provider,
        model: input.model,
        inputUsdPer1m: input.inputUsdPer1m ?? null,
        outputUsdPer1m: input.outputUsdPer1m ?? null,
        cacheReadUsdPer1m: input.cacheReadUsdPer1m ?? null,
        cacheWriteUsdPer1m: input.cacheWriteUsdPer1m ?? null,
        source: input.source ?? null,
        effectiveAt: input.effectiveAt ?? now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: usagePriceSnapshots.id,
        set: {
          inputUsdPer1m: input.inputUsdPer1m ?? null,
          outputUsdPer1m: input.outputUsdPer1m ?? null,
          cacheReadUsdPer1m: input.cacheReadUsdPer1m ?? null,
          cacheWriteUsdPer1m: input.cacheWriteUsdPer1m ?? null,
          source: input.source ?? null,
        },
      })
      .run();
    return id;
  }

  close(): void {
    if (this.ownsDb) {
      closeCodingDatabase(this.db);
    }
  }
}

function zeroUsage(): AgentUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
  };
}

function buildUsageFilter(filter: UsageFilter) {
  const conditions = [
    filter.since !== undefined
      ? gte(usageRecords.startedAt, filter.since)
      : undefined,
    filter.until !== undefined
      ? lte(usageRecords.startedAt, filter.until)
      : undefined,
    filter.model !== undefined
      ? eq(usageRecords.model, filter.model)
      : undefined,
    filter.status !== undefined
      ? eq(usageRecords.status, filter.status)
      : undefined,
  ].filter(
    (condition): condition is NonNullable<typeof condition> =>
      condition !== undefined,
  );
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function normalizeUsageRecord(
  row: typeof usageRecords.$inferSelect | typeof usageRecords.$inferInsert,
): UsageRecord {
  return {
    id: row.id,
    ...(row.runId !== null && row.runId !== undefined
      ? { runId: row.runId }
      : {}),
    invocation: row.invocation as UsageInvocation,
    ...(row.provider !== null && row.provider !== undefined
      ? { provider: row.provider }
      : {}),
    model: row.model,
    status: row.status as UsageStatus,
    ...(row.finishReason !== null && row.finishReason !== undefined
      ? { finishReason: row.finishReason }
      : {}),
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    toolCalls: row.toolCalls,
    ...(row.estimatedCostUsd !== null && row.estimatedCostUsd !== undefined
      ? { estimatedCostUsd: row.estimatedCostUsd }
      : {}),
    startedAt: row.startedAt,
    ...(row.completedAt !== null && row.completedAt !== undefined
      ? { completedAt: row.completedAt }
      : {}),
    createdAt: row.createdAt,
  };
}
