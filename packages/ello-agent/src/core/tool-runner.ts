import { tool, type ToolSet } from 'ai';

import type { AnyAgentTool } from '../public/types.js';

export interface BuildToolSetOptions {
  readonly tools: readonly AnyAgentTool[];
}

export class AgentApprovalRequiredError extends Error {
  readonly kind = 'approval-required';

  constructor(
    readonly toolCallId: string,
    readonly toolName: string,
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
