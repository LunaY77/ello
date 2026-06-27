import type { UsageSnapshot } from '../usage.js';
import { coerceRunUsage, type RunUsage } from '../usage.js';

export function usageToRunUsage(usage: {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
}): RunUsage {
  return {
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    toolCalls: usage.toolCalls,
  };
}

export function recordUsageFromResult(
  ctx: {
    recordUsage(entry: Parameters<UsageSnapshot['record']>[0]): void;
  } | null,
  result: unknown,
  agentId: string,
  modelId: string,
  source = 'model_request',
): void {
  if (ctx === null) {
    return;
  }

  const usage = (result as { usage?: unknown }).usage;
  if (usage === undefined || usage === null) {
    return;
  }

  const normalized = coerceRunUsage(usage as never);
  ctx.recordUsage({
    agentId,
    agentName: agentId,
    modelId,
    usage: usageToRunUsage(normalized),
    source,
  });
}
