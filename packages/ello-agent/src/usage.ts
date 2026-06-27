/**
 * 模型调用 usage 统计。
 */
export interface RunUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
}

export type RunUsageLike = Partial<RunUsage> | (() => Partial<RunUsage>);

/**
 * 创建空 usage。
 */
export function createEmptyUsage(): RunUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
  };
}

/**
 * 将部分 usage 对象转换为完整 RunUsage。
 */
export function coerceRunUsage(usage: RunUsageLike): RunUsage {
  const value = typeof usage === 'function' ? usage() : usage;
  const candidate = value as Partial<RunUsage>;
  return {
    requests: candidate.requests ?? 0,
    inputTokens: candidate.inputTokens ?? 0,
    outputTokens: candidate.outputTokens ?? 0,
    cacheReadTokens: candidate.cacheReadTokens ?? 0,
    cacheWriteTokens: candidate.cacheWriteTokens ?? 0,
    toolCalls: candidate.toolCalls ?? 0,
  };
}

/**
 * 合并两个 usage。
 */
export function addUsage(a: RunUsageLike, b: RunUsageLike): RunUsage {
  const left = coerceRunUsage(a);
  const right = coerceRunUsage(b);
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    toolCalls: left.toolCalls + right.toolCalls,
  };
}

/**
 * 单个 agent/source 的累计 usage 记录。
 */
export interface UsageSnapshotEntry {
  agentId: string;
  agentName: string;
  modelId: string;
  usage: RunUsage;
  source: string;
}

export type UsageSnapshotEntryLike = UsageSnapshotEntry;

/**
 * 按 agent 分组的累计 usage。
 */
export interface UsageAgentTotal {
  agentName: string;
  modelId: string;
  usage: RunUsage;
  source: string;
}

/**
 * 运行级别的累计 usage 快照。
 */
export class UsageSnapshot {
  readonly runId: string;
  totalUsage: RunUsage;
  readonly entries: UsageSnapshotEntry[] = [];
  readonly agentUsages = new Map<string, UsageAgentTotal>();
  readonly modelUsages = new Map<string, RunUsage>();

  constructor(runId: string) {
    this.runId = runId;
    this.totalUsage = createEmptyUsage();
  }

  /** 按 agent ID 分组的 usage。 */
  get agentUsageTotals(): Record<string, UsageAgentTotal> {
    return Object.fromEntries(this.agentUsages.entries());
  }

  /** 按 model ID 分组的 usage。 */
  get modelUsageTotals(): Record<string, RunUsage> {
    return Object.fromEntries(this.modelUsages.entries());
  }

  /**
   * 记录一条 usage entry 并更新汇总。
   */
  record(entry: UsageSnapshotEntryLike): void {
    const normalized = normalizeUsageEntry(entry);
    this.entries.push(normalized);
    this.totalUsage = addUsage(this.totalUsage, normalized.usage);

    const existingAgent = this.agentUsages.get(normalized.agentId);
    if (existingAgent) {
      existingAgent.usage = addUsage(existingAgent.usage, normalized.usage);
    } else {
      this.agentUsages.set(normalized.agentId, {
        agentName: normalized.agentName,
        modelId: normalized.modelId,
        usage: normalized.usage,
        source: normalized.source,
      });
    }

    const existingModel = this.modelUsages.get(normalized.modelId);
    this.modelUsages.set(
      normalized.modelId,
      existingModel
        ? addUsage(existingModel, normalized.usage)
        : normalized.usage,
    );
  }
}

function normalizeUsageEntry(
  entry: UsageSnapshotEntryLike,
): UsageSnapshotEntry {
  return {
    ...entry,
    usage: coerceRunUsage(entry.usage),
  };
}
