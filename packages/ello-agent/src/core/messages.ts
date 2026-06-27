import type { AgentInput, AgentMessage } from '../public/types.js';

/**
 * 将公开输入统一为 ModelMessage 序列。
 *
 * Args:
 *   input: string、AgentMessage[] 或结构化 AgentInput。
 *
 * Returns:
 *   可直接传给模型 adapter 的 AgentMessage[]。
 */
export function normalizeInput(input: AgentInput): AgentMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return [...input];
  }
  if (input.messages !== undefined) {
    return [...input.messages];
  }
  if (input.prompt !== undefined) {
    return [{ role: 'user', content: input.prompt }];
  }
  return [];
}
