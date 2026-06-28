/**
 * 框架工具到 AI SDK `ToolSet` 的桥接层。
 *
 * 该模块只把框架工具的名称、描述与入参 schema 暴露给 Vercel AI SDK，让模型
 * 知道有哪些工具可用，但刻意不提供 `execute`。真正的工具执行交由 core 的
 * 工具调度器统一处理，从而把审批暂停留在框架内部，避免被 provider 或工具
 * 适配器吞掉。
 */

import { tool, type ToolSet } from 'ai';

import type { AnyAgentTool } from '../public/types.js';

/** {@link buildToolSet} 的入参。 */
export interface BuildToolSetOptions {
  /** 待暴露给模型的框架工具列表。 */
  readonly tools: readonly AnyAgentTool[];
}

/**
 * 工具需要人工审批时抛出的错误。
 *
 * 用作执行被中断、需上抛到调度层挂起等待批准的信号，携带定位与重放该 tool
 * call 所需的 `toolCallId` / `toolName` / `input`。
 */
export class AgentApprovalRequiredError extends Error {
  /** 错误判别标记，便于按类型而非 `instanceof` 识别。 */
  readonly kind = 'approval-required';

  constructor(
    /** 触发审批的 tool call 标识。 */
    readonly toolCallId: string,
    /** 触发审批的工具名。 */
    readonly toolName: string,
    /** 触发审批时的工具入参，用于审批界面展示与批准后重放。 */
    readonly input: unknown,
  ) {
    super(`Tool '${toolName}' requires approval.`);
    this.name = 'AgentApprovalRequiredError';
  }
}

/**
 * 将框架工具转换为 AI SDK ToolSet。
 *
 * Args:
 *   options.tools: AgentTool 列表。
 *
 * Returns:
 *   可传给 Vercel AI SDK generateText/streamText 的 ToolSet。
 *
 * 这里只暴露 schema 和描述，不提供 execute。工具执行由 core ToolScheduler
 * 统一处理，避免审批暂停被 provider/tool adapter 吞掉。
 */
export function buildToolSet(options: BuildToolSetOptions): ToolSet {
  const result: ToolSet = {};
  for (const agentTool of options.tools) {
    result[agentTool.name] = tool({
      description: agentTool.description,
      inputSchema: agentTool.input,
    });
  }
  return result;
}
