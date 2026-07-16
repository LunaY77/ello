/**
 * Agent 工厂入口。
 *
 * 暴露 `createAgent`：把 {@link CreateAgentOptions} 装配成内部 `ElloAgent` 实例，
 * 并以稳定的 {@link Agent} 接口（run/stream/resume/close）对外返回，从而把内核
 * 内部实现与调用方隔离开。
 */
import { ElloAgent } from '../core/agent.js';

import type { Agent, CreateAgentOptions } from './types.js';

/**
 * 创建新的稳定 Agent 接口。
 *
 * Args:
 *   options: Agent 的模型、指令、环境、工具、扩展和 adapter 配置。
 *
 * Returns:
 *   只暴露 run/stream/close 的 Agent 实例。
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   model: 'openai:gpt-4.1-mini',
 *   instructions: 'Answer in one sentence.',
 *   executionTools: [tool],
 *   modelTools: [tool],
 * });
 *
 * const result = await agent.run('What changed?');
 * console.log(result.output);
 * await agent.close();
 * ```
 */
export function createAgent(options: CreateAgentOptions): Agent {
  assertToolCollections(options);
  return new ElloAgent(options);
}

function assertToolCollections(options: CreateAgentOptions): void {
  // 在创建入口尽早检查，避免运行到模型调用时才暴露工具集配置错误。
  if (
    !Array.isArray(options.executionTools) ||
    !Array.isArray(options.modelTools)
  ) {
    throw new Error('executionTools and modelTools are required.');
  }
  if (options.executionTools.length === 0 || options.modelTools.length === 0) {
    throw new Error('executionTools and modelTools must both be non-empty.');
  }
  const executionNames = uniqueNames(options.executionTools, 'executionTools');
  uniqueNames(options.modelTools, 'modelTools');
  for (const tool of options.modelTools) {
    if (!executionNames.has(tool.name)) {
      throw new Error(
        `Model tool '${tool.name}' is not registered in executionTools.`,
      );
    }
  }
}

function uniqueNames(
  tools: readonly { readonly name: string }[],
  collection: string,
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.name.trim() === '') {
      throw new Error(`${collection} contains an empty tool name.`);
    }
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool '${tool.name}' in ${collection}.`);
    }
    names.add(tool.name);
  }
  return names;
}
