import type { AgentUsage } from '../api/types.js';

/**
 * 用量（token / 请求数）记账工具。
 *
 * 统一内核与 AI SDK 的用量形状，并提供初始化与累加原语：
 * - `createEmptyUsage`：全零起点；
 * - `mapAiSdkUsage`：严格读取 AI SDK 7 的 usage 契约；
 * - `addUsage`：逐字段相加，用于跨多次调用累计。
 */

/** 创建一个所有计数均为 0 的空用量。 */
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
 * 严格读取 AI SDK 7 usage。token 字段为 undefined 表示 provider 未报告，记为 0；
 * usage 对象或 `inputTokenDetails` 结构不合法时直接失败。
 */
export function mapAiSdkUsage(usage: unknown): AgentUsage {
  if (typeof usage !== 'object' || usage === null) {
    throw new Error('AI SDK usage must be an object.');
  }
  const value = usage as {
    readonly inputTokens?: unknown;
    readonly outputTokens?: unknown;
    readonly inputTokenDetails?: unknown;
  };
  if (
    typeof value.inputTokenDetails !== 'object' ||
    value.inputTokenDetails === null
  ) {
    throw new Error('AI SDK usage.inputTokenDetails must be an object.');
  }
  const inputTokenDetails = value.inputTokenDetails as {
    readonly cacheReadTokens?: unknown;
    readonly cacheWriteTokens?: unknown;
  };
  return {
    requests: 1,
    inputTokens: optionalTokenCount(value.inputTokens, 'inputTokens'),
    outputTokens: optionalTokenCount(value.outputTokens, 'outputTokens'),
    cacheReadTokens: optionalTokenCount(
      inputTokenDetails.cacheReadTokens,
      'inputTokenDetails.cacheReadTokens',
    ),
    cacheWriteTokens: optionalTokenCount(
      inputTokenDetails.cacheWriteTokens,
      'inputTokenDetails.cacheWriteTokens',
    ),
    toolCalls: 0,
  };
}

/** 逐字段相加两份用量，用于跨调用累计。 */
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

function optionalTokenCount(value: unknown, field: string): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`AI SDK usage.${field} must be a non-negative number.`);
  }
  return value;
}
