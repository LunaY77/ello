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
 * 合并两个 usage。
 */
export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    toolCalls: a.toolCalls + b.toolCalls,
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

  /**
   * 记录一条 usage entry 并更新汇总。
   */
  record(entry: UsageSnapshotEntry): void {
    this.entries.push(entry);
    this.totalUsage = addUsage(this.totalUsage, entry.usage);

    const existingAgent = this.agentUsages.get(entry.agentId);
    if (existingAgent) {
      existingAgent.usage = addUsage(existingAgent.usage, entry.usage);
    } else {
      this.agentUsages.set(entry.agentId, {
        agentName: entry.agentName,
        modelId: entry.modelId,
        usage: entry.usage,
        source: entry.source,
      });
    }

    const existingModel = this.modelUsages.get(entry.modelId);
    this.modelUsages.set(
      entry.modelId,
      existingModel ? addUsage(existingModel, entry.usage) : entry.usage,
    );
  }
}
