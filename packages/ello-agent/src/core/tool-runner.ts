import { tool, type ToolSet } from 'ai';

import { normalizeAgentError } from '../public/errors.js';
import type {
  AgentEnvironment,
  AnyAgentTool,
  AgentToolCall,
  AgentToolContext,
} from '../public/types.js';

export interface BuildToolSetOptions {
  readonly runId: string;
  readonly tools: readonly AnyAgentTool[];
  readonly environment: AgentEnvironment;
  readonly metadata: Record<string, unknown>;
  readonly toolCalls: AgentToolCall[];
  readonly emitToolStarted: (toolCallId: string, name: string, input: unknown) => void;
  readonly emitApprovalRequired?: (
    toolCallId: string,
    name: string,
    input: unknown,
  ) => void;
  readonly emitToolCompleted: (toolCallId: string, output: unknown) => void;
  readonly emitToolFailed: (toolCallId: string, error: Error) => void;
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
 *   options.runId: 当前 run ID。
 *   options.tools: AgentTool 列表。
 *   options.environment: 工具执行环境。
 *   options.metadata: 本次 run 元数据。
 *   options.toolCalls: 用于记录工具调用摘要的可变数组。
 *   options.emitToolStarted: 工具开始事件回调。
 *   options.emitToolCompleted: 工具完成事件回调。
 *   options.emitToolFailed: 工具失败事件回调。
 *
 * Returns:
 *   可传给 Vercel AI SDK generateText/streamText 的 ToolSet。
 */
export function buildToolSet(options: BuildToolSetOptions): ToolSet {
  const result: ToolSet = {};
  for (const agentTool of options.tools) {
    result[agentTool.name] = tool({
      description: agentTool.description,
      inputSchema: agentTool.input,
      execute: async (input, executionOptions) => {
        const toolCallId = executionOptions.toolCallId;
        const decision = await agentTool.approval?.(input, createToolContext(options));
        if (decision === 'denied') {
          throw new Error(`Tool '${agentTool.name}' was denied by approval policy.`);
        }
        if (decision === 'required') {
          options.emitApprovalRequired?.(toolCallId, agentTool.name, input);
          throw new AgentApprovalRequiredError(toolCallId, agentTool.name, input);
        }
        options.emitToolStarted(toolCallId, agentTool.name, input);
        try {
          const output = await agentTool.execute(input, createToolContext(options));
          options.toolCalls.push({
            id: toolCallId,
            name: agentTool.name,
            input,
            output,
          });
          options.emitToolCompleted(toolCallId, output);
          return output;
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          options.toolCalls.push({
            id: toolCallId,
            name: agentTool.name,
            input,
            error: normalizeAgentError(normalized),
          });
          options.emitToolFailed(toolCallId, normalized);
          throw normalized;
        }
      },
    });
  }
  return result;
}

function createToolContext(options: BuildToolSetOptions): AgentToolContext {
  return {
    runId: options.runId,
    environment: options.environment,
    metadata: options.metadata,
  };
}
