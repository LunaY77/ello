import type { ModelMessage } from 'ai';

import type { AgentContext } from '../context.js';
import { resolveModel } from '../models.js';
import { Toolset } from '../toolsets/index.js';
import type { SubagentWrapper } from '../wrappers.js';

import type { SubagentConfig } from './config.js';

export const INHERIT = 'inherit';

/** 子 agent run 结果。 */
export interface SubagentRunResult {
  output: string;
  allMessages(): ModelMessage[];
}

/** 子 agent runner 接口。 */
export interface SubagentRunner {
  readonly name: string;
  readonly config: SubagentConfig;
  readonly toolset: Toolset;
  run(
    prompt: string,
    options: { deps: AgentContext; messages?: ModelMessage[] | null },
  ): Promise<SubagentRunResult>;
}

/** buildSubagentAgent 的构造参数。 */
export interface BuildSubagentAgentOptions {
  model?: string | null;
  parentAgentName?: string | null;
  subagentWrapper?: SubagentWrapper | null;
}

/**
 * 从 SubagentConfig 构建子 agent runner。
 *
 * TS 版先提供一个可注入、可测试的 runner 抽象, 后续可替换为完整
 * AgentRuntime 驱动实现。
 */
export async function buildSubagentAgent(
  config: SubagentConfig,
  parentToolset: Toolset,
  options: BuildSubagentAgentOptions = {},
): Promise<SubagentRunner> {
  const effectiveModel = resolveSubagentModel(config, options.model ?? null);
  const selection = resolveModel({ modelName: effectiveModel });
  const childToolset = parentToolset.subset({
    toolNames: config.tools,
    excludeTags: new Set(['delegation']),
  });
  const wrappedModel = options.subagentWrapper
    ? await options.subagentWrapper(
        selection.model,
        options.parentAgentName ?? 'main',
        config.name,
        {
          modelName: selection.modelName,
          description: config.description,
        },
      )
    : selection.model;
  return new StaticSubagentRunner(config, childToolset, wrappedModel);
}

/** 解析 subagent 使用的 model。 */
export function resolveSubagentModel(
  config: SubagentConfig,
  fallback: string | null,
): string {
  if (config.model !== null && config.model !== INHERIT) {
    return config.model;
  }
  return fallback ?? 'test';
}

class StaticSubagentRunner implements SubagentRunner {
  readonly name: string;

  constructor(
    readonly config: SubagentConfig,
    readonly toolset: Toolset,
    readonly model: unknown = null,
  ) {
    this.name = config.name;
  }

  async run(
    prompt: string,
    options: { deps: AgentContext; messages?: ModelMessage[] | null },
  ): Promise<SubagentRunResult> {
    const messages: ModelMessage[] = [
      ...(options.messages ?? []),
      { role: 'user', content: prompt },
      { role: 'assistant', content: this.config.systemPrompt },
    ];
    return {
      output: this.config.systemPrompt,
      allMessages: () => messages,
    };
  }
}
