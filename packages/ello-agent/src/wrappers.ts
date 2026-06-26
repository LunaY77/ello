import type { LanguageModel } from 'ai';

/** 在 Agent 创建时包装 Model, 返回包装后的实例。支持同步和异步。 */
export type AsyncModelWrapper = (
  model: LanguageModel,
  agentName: string,
  metadata: Record<string, unknown>,
) => LanguageModel | Promise<LanguageModel>;

/** 在 subagent 创建时包装 Model。 */
export type SubagentWrapper = (
  model: LanguageModel,
  parentAgentName: string,
  subagentName: string,
  metadata: Record<string, unknown>,
) => LanguageModel | Promise<LanguageModel>;

/**
 * 应用 model wrapper, 处理同步/异步返回值。
 *
 * Args:
 *   wrapper: AsyncModelWrapper 或 null。
 *   model: 原始 model。
 *   agentName: agent 名称。
 *   metadata: 元数据字典。
 *
 * Returns:
 *   包装后的 Model; wrapper 为 null 时返回原始 model。
 */
export async function applyModelWrapper(
  wrapper: AsyncModelWrapper | null | undefined,
  model: LanguageModel,
  agentName: string,
  metadata: Record<string, unknown>,
): Promise<LanguageModel> {
  if (wrapper === null || wrapper === undefined) {
    return model;
  }
  return wrapper(model, agentName, metadata);
}

/**
 * 应用 subagent wrapper, 处理同步/异步返回值。
 *
 * Args:
 *   wrapper: SubagentWrapper 或 null。
 *   model: 原始 model。
 *   parentAgentName: 父 agent 名称。
 *   subagentName: 子 agent 名称。
 *   metadata: 元数据字典。
 *
 * Returns:
 *   包装后的 Model; wrapper 为 null 时返回原始 model。
 */
export async function applySubagentWrapper(
  wrapper: SubagentWrapper | null | undefined,
  model: LanguageModel,
  parentAgentName: string,
  subagentName: string,
  metadata: Record<string, unknown>,
): Promise<LanguageModel> {
  if (wrapper === null || wrapper === undefined) {
    return model;
  }
  return wrapper(model, parentAgentName, subagentName, metadata);
}
