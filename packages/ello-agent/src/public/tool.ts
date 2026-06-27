import type { z } from 'zod';

import type { AgentTool, AgentToolContext, MaybePromise } from './types.js';

export interface DefineToolOptions<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  readonly execute: (
    input: TInput,
    ctx: AgentToolContext,
  ) => MaybePromise<TOutput>;
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
