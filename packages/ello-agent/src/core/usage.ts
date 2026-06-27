import type { AgentUsage } from '../public/types.js';

/**
 * 创建空 usage。
 *
 * Returns:
 *   所有计数为 0 的 AgentUsage。
 */
export function createEmptyUsage(): AgentUsage {
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
 * 归一化不同 provider 的 usage 形状。
 *
 * Args:
 *   usage: provider 返回的 usage 对象，字段可能来自 AI SDK 或兼容 provider。
 *
 * Returns:
 *   完整 AgentUsage。
 */
export function coerceUsage(usage: unknown): AgentUsage {
  if (typeof usage !== 'object' || usage === null) {
    return createEmptyUsage();
  }
  const value = usage as Record<string, unknown>;
  return {
    requests: numberValue(value.requests, 1),
    inputTokens: numberValue(value.inputTokens, numberValue(value.promptTokens, 0)),
    outputTokens: numberValue(
      value.outputTokens,
      numberValue(value.completionTokens, 0),
    ),
    cacheReadTokens: numberValue(value.cacheReadTokens, 0),
    cacheWriteTokens: numberValue(value.cacheWriteTokens, 0),
    toolCalls: numberValue(value.toolCalls, 0),
  };
}

export function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    toolCalls: left.toolCalls + right.toolCalls,
  };
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
