/**
 * 工具定义辅助。
 *
 * 提供 `defineTool` 工厂，把 Zod 输入 schema、执行函数与可选审批策略包装成内核
 * 可消费的 {@link AgentTool}，并让 `TInput` 从 schema 自动推导，省去手写类型。
 */
import type { z } from 'zod';

import type { AgentTool, AgentToolContext, MaybePromise } from './types.js';

/** {@link defineTool} 的入参。 */
export interface DefineToolOptions<TInput, TOutput> {
  /** 工具名（模型调用时使用）。 */
  readonly name: string;
  /** 工具描述（供模型选择工具）。 */
  readonly description: string;
  /** 输入 Zod schema，用于校验并推导 `TInput`。 */
  readonly input: z.ZodType<TInput>;
  /** 实际执行函数。 */
  readonly execute: (
    input: TInput,
    ctx: AgentToolContext,
  ) => MaybePromise<TOutput>;
  /** 可选审批策略。 */
  readonly approval?: AgentTool<TInput, TOutput>['approval'];
}

/**
 * 定义函数式 Agent 工具，类型从 Zod schema 推导。
 *
 * Args:
 *   options.name: 模型调用时看到的工具名。
 *   options.description: 模型选择工具时使用的描述。
 *   options.input: Zod 输入 schema。
 *   options.execute: 实际执行函数。
 *   options.approval: 可选审批策略。
 *
 * Returns:
 *   可传给 createAgent({ tools }) 的 AgentTool。
 *
 * @example
 * ```ts
 * const shellEcho = defineTool({
 *   name: 'echo',
 *   description: 'Echo a string',
 *   input: z.object({ text: z.string() }),
 *   execute: ({ text }) => text,
 * });
 * ```
 */
export function defineTool<TInput, TOutput>(
  options: DefineToolOptions<TInput, TOutput>,
): AgentTool<TInput, TOutput> {
  return {
    name: options.name,
    description: options.description,
    input: options.input,
    execute: options.execute,
    ...(options.approval !== undefined ? { approval: options.approval } : {}),
  };
}
