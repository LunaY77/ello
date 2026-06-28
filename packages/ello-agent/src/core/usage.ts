import type { AgentUsage } from '../public/types.js';

/**
 * 用量（token / 请求数）记账工具。
 *
 * 屏蔽不同 provider 的字段差异，统一成内核的 {@link AgentUsage} 形状，
 * 并提供初始化与累加原语：
 * - `createEmptyUsage`：全零起点；
 * - `coerceUsage`：把 provider 返回的杂形状归一（兼容 AI SDK 的
 *   `promptTokens`/`completionTokens` 别名），非法字段回落默认值；
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
 * 把 provider 返回的任意用量形状归一为 {@link AgentUsage}。
 *
 * 非对象输入直接回落空用量；`inputTokens`/`outputTokens` 兼容 AI SDK 的
 * `promptTokens`/`completionTokens` 别名；`requests` 缺省记为 1（一次调用）。
 *
 * @param usage provider 返回的用量对象，字段形状可能各异。
 */
export function coerceUsage(usage: unknown): AgentUsage {
  if (typeof usage !== 'object' || usage === null) {
    return createEmptyUsage();
  }
  const value = usage as Record<string, unknown>;
  return {
    requests: numberValue(value.requests, 1),
    // 优先取标准字段，否则回落到 AI SDK 的别名。
    inputTokens: numberValue(
      value.inputTokens,
      numberValue(value.promptTokens, 0),
    ),
    outputTokens: numberValue(
      value.outputTokens,
      numberValue(value.completionTokens, 0),
    ),
    cacheReadTokens: numberValue(value.cacheReadTokens, 0),
    cacheWriteTokens: numberValue(value.cacheWriteTokens, 0),
    toolCalls: numberValue(value.toolCalls, 0),
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

/** 取有限数值，非数字或非有限值时回落到 `fallback`。 */
function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
