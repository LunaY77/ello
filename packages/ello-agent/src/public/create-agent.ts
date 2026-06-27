import { CoreAgent } from '../core/agent.js';

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
 * });
 *
 * const result = await agent.run('What changed?');
 * console.log(result.output);
 * await agent.close();
 * ```
 */
export function createAgent(options: CreateAgentOptions): Agent {
  return new CoreAgent(options);
}
