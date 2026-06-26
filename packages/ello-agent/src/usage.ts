/**
 * 模型调用 usage 统计。
 *
 * 字段名贴近 Vercel AI SDK usage 结构, 同时保留 Python 版 RunUsage 的
 * requests/toolCalls 维度, 方便后续实现 per-agent/per-model 汇总。
 */
export interface RunUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
}

/** RunUsage 的 Python snake_case 兼容输入。 */
export interface PythonRunUsageLike {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  tool_calls?: number;
}

/** RunUsage 的 TS camelCase 兼容输入。 */
export type RunUsageLike =
  | Partial<RunUsage>
  | PythonRunUsageLike
  | (() => Partial<RunUsage> | PythonRunUsageLike);

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
 * 将 RunUsage 兼容对象转换为标准 camelCase RunUsage。
 *
 * Args:
 *   usage: camelCase/snake_case usage 对象, 或返回 usage 对象的函数。
 *
 * Returns:
 *   填充默认值后的 RunUsage。
 */
export function coerceRunUsage(usage: RunUsageLike): RunUsage {
  const value = typeof usage === 'function' ? usage() : usage;
  const candidate = value as Partial<RunUsage> & PythonRunUsageLike;
  return {
    requests: candidate.requests ?? 0,
    inputTokens: candidate.inputTokens ?? candidate.input_tokens ?? 0,
    outputTokens: candidate.outputTokens ?? candidate.output_tokens ?? 0,
    cacheReadTokens:
      candidate.cacheReadTokens ?? candidate.cache_read_tokens ?? 0,
    cacheWriteTokens:
      candidate.cacheWriteTokens ?? candidate.cache_write_tokens ?? 0,
    toolCalls: candidate.toolCalls ?? candidate.tool_calls ?? 0,
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

/** UsageSnapshotEntry 的 Python snake_case 兼容输入。 */
export interface PythonUsageSnapshotEntryLike {
  agent_id: string;
  agent_name: string;
  model_id: string;
  usage: RunUsageLike;
  source?: string;
}

/** UsageSnapshotEntry 的 TS/Python 兼容输入。 */
export type UsageSnapshotEntryLike =
  | UsageSnapshotEntry
  | PythonUsageSnapshotEntryLike;

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

  /** Python 兼容命名: Run 标识。 */
  get run_id(): string {
    return this.runId;
  }

  /** Python 兼容命名: 总 usage。 */
  get total_usage(): RunUsage {
    return this.totalUsage;
  }

  /** Python 兼容命名: 按 agent ID 分组的 usage。 */
  get agent_usages(): Record<string, UsageAgentTotal> {
    return Object.fromEntries(this.agentUsages.entries());
  }

  /** Python 兼容命名: 按 model ID 分组的 usage。 */
  get model_usages(): Record<string, RunUsage> {
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
  if ('agentId' in entry) {
    return {
      ...entry,
      usage: coerceRunUsage(entry.usage),
    };
  }
  return {
    agentId: entry.agent_id,
    agentName: entry.agent_name,
    modelId: entry.model_id,
    usage: coerceRunUsage(entry.usage),
    source: entry.source ?? 'model_request',
  };
}
