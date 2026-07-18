import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type {
  AgentFinishReason,
  EngineEvent,
  AgentUsage,
} from '../../agent/engine/index.js';
import type { CodingDatabase } from '../database/database.js';
import {
  usageModelCalls,
  usagePriceSnapshots,
  usageRecords,
} from '../database/schema.js';

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
  readonly cacheReadRatio?: number;
  readonly cacheWriteRatio?: number;
  readonly uncachedInputTokens: number;
}

type CompletedModelCall = Extract<
  EngineEvent,
  { type: 'model.completed' }
>;

export interface UsageModelCallRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: string;
  readonly turnIndex: number;
  readonly provider: string;
  readonly model: string;
  readonly finishReason: AgentFinishReason;
  readonly usage: AgentUsage;
  readonly durationMs: number;
  readonly systemFingerprint: string;
  readonly toolsetFingerprint: string;
  readonly messagePrefixFingerprint: string;
  readonly compactionBoundary: boolean;
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
  constructor(private readonly db: CodingDatabase) {}

  recordModelCall(input: CompletedModelCall): UsageModelCallRecord {
    const durationMs =
      Date.parse(input.occurredAt) - Date.parse(input.startedAt);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('Model call durationMs must be a non-negative number.');
    }
    const row = {
      id: randomUUID(),
      runId: input.runId,
      turnIndex: input.identity.turnIndex,
      provider: input.identity.provider,
      model: input.identity.model,
      finishReason: input.response.finishReason,
      inputTokens: input.response.usage.inputTokens,
      outputTokens: input.response.usage.outputTokens,
      cacheReadTokens: input.response.usage.cacheReadTokens,
      cacheWriteTokens: input.response.usage.cacheWriteTokens,
      durationMs,
      systemFingerprint: input.diagnostics.systemFingerprint,
      toolsetFingerprint: input.diagnostics.toolsetFingerprint,
      messagePrefixFingerprint: input.diagnostics.messagePrefixFingerprint,
      compactionBoundary: input.diagnostics.compactionBoundary,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(usageModelCalls).values(row).run();
    return {
      id: row.id,
      createdAt: row.createdAt,
      runId: input.runId,
      turnIndex: input.identity.turnIndex,
      provider: input.identity.provider,
      model: input.identity.model,
      finishReason: input.response.finishReason,
      usage: input.response.usage,
      durationMs,
      systemFingerprint: input.diagnostics.systemFingerprint,
      toolsetFingerprint: input.diagnostics.toolsetFingerprint,
      messagePrefixFingerprint: input.diagnostics.messagePrefixFingerprint,
      compactionBoundary: input.diagnostics.compactionBoundary,
    };
  }

  listModelCalls(runId: string): readonly UsageModelCallRecord[] {
    return this.db
      .select()
      .from(usageModelCalls)
      .where(eq(usageModelCalls.runId, runId))
      .orderBy(asc(usageModelCalls.turnIndex))
      .all()
      .map((row) => ({
        id: row.id,
        runId: row.runId,
        turnIndex: row.turnIndex,
        provider: row.provider,
        model: row.model,
        finishReason: row.finishReason as AgentFinishReason,
        usage: {
          requests: 1,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          toolCalls: 0,
        },
        durationMs: row.durationMs,
        systemFingerprint: row.systemFingerprint,
        toolsetFingerprint: row.toolsetFingerprint,
        messagePrefixFingerprint: row.messagePrefixFingerprint,
        compactionBoundary: row.compactionBoundary,
        createdAt: row.createdAt,
      }));
  }

  recordRunSummary(
    input: Omit<RecordUsageInput, 'usage'> & {
      readonly runId: string;
      readonly toolCalls: number;
    },
  ): UsageRecord {
    const aggregate = this.db
      .select({
        requests: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${usageModelCalls.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usageModelCalls.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${usageModelCalls.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${usageModelCalls.cacheWriteTokens}), 0)`,
      })
      .from(usageModelCalls)
      .where(eq(usageModelCalls.runId, input.runId))
      .get();
    if (aggregate === undefined) {
      throw new Error(
        `Failed to aggregate model calls for run ${input.runId}.`,
      );
    }
    const { toolCalls, ...record } = input;
    return this.recordUsage({
      ...record,
      usage: {
        requests: Number(aggregate.requests),
        inputTokens: Number(aggregate.inputTokens),
        outputTokens: Number(aggregate.outputTokens),
        cacheReadTokens: Number(aggregate.cacheReadTokens),
        cacheWriteTokens: Number(aggregate.cacheWriteTokens),
        toolCalls,
      },
    });
  }

  recordUsage(input: RecordUsageInput): UsageRecord {
    const now = new Date().toISOString();
    if (input.status === 'completed' && input.usage === undefined) {
      throw new Error(
        `Completed usage record ${input.runId ?? '<unknown>'} is missing usage.`,
      );
    }
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

  listRecords(filter: UsageFilter = {}): readonly UsageRecord[] {
    const rows = this.db
      .select()
      .from(usageRecords)
      .where(buildUsageFilter(filter))
      .orderBy(desc(usageRecords.startedAt))
      .all();
    return rows.map(normalizeUsageRecord);
  }

  summarize(
    filter: UsageFilter = {},
    groupBy: UsageGroupBy = 'model',
  ): readonly UsageSummaryRow[] {
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
    return rows.map((row) => {
      const inputTokens = Number(row.inputTokens);
      const cacheReadTokens = Number(row.cacheReadTokens);
      const cacheWriteTokens = Number(row.cacheWriteTokens);
      return {
        key: row.key,
        requests: Number(row.requests),
        inputTokens,
        outputTokens: Number(row.outputTokens),
        cacheReadTokens,
        cacheWriteTokens,
        toolCalls: Number(row.toolCalls),
        estimatedCostUsd: Number(row.estimatedCostUsd),
        runs: Number(row.runs),
        ...(inputTokens > 0
          ? {
              cacheReadRatio: cacheReadTokens / inputTokens,
              cacheWriteRatio: cacheWriteTokens / inputTokens,
            }
          : {}),
        uncachedInputTokens: inputTokens - cacheReadTokens,
      };
    });
  }

  upsertPriceSnapshot(input: PriceSnapshotInput): string {
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
