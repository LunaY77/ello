/**
 * 本文件负责 agent feature 的“tool”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { defineDeferredTool } from '../engine/index.js';

import { UserInputRequestSchema } from './schema.js';

export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';

/**
 * 构造 产品 Agent `tool` 模块 中的 `createRequestUserInputTool` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createRequestUserInputTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent `tool` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createRequestUserInputTool() {
  return defineDeferredTool({
    name: REQUEST_USER_INPUT_TOOL_NAME,
    description:
      'Ask the user 1-3 short questions only when repository inspection cannot resolve a choice that materially changes architecture, scope, risk, or user preference. Put the recommended option first and explain why. Call this tool by itself; never use it for permissions or Plan Mode exit.',
    discovery: {
      aliases: ['ask user', 'clarify requirements'],
      risk: 'readonly',
    },
    input: UserInputRequestSchema,
  });
}
