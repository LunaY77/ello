/**
 * 本文件负责 tool feature 的“adapter”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import {
  defineTool,
  type AnyAgentTool,
  type AgentToolContext,
} from '../../../agent/engine/index.js';
import type { CodingAgentConfig } from '../../../config/index.js';

import type { AnyCodingTool, CodingToolContext } from './coding-tool.js';
import {
  persistLargeOutput,
  type ToolOutputLimits,
  type ToolOutputStore,
} from './output-store.js';

export interface CodingToolAdapterOptions {
  readonly config: CodingAgentConfig;
  readonly outputStore: ToolOutputStore;
}

/**
 * 执行 工具 `adapter` 模块 定义的 `adaptCodingTool` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `tool`: `adaptCodingTool` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `options`: 仅作用于 `adaptCodingTool` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `adaptCodingTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function adaptCodingTool(
  tool: AnyCodingTool,
  options: CodingToolAdapterOptions,
): AnyAgentTool {
  const approval = tool.approval;
  return defineTool({
    name: tool.name,
    description: tool.description,
    discovery: tool.discovery,
    input: tool.input,
    approval:
      approval === undefined
        ? undefined
        : (input, ctx) => approval(input, createContext(ctx, options.config)),
    execute: async (input, ctx) => {
      const codingContext = createContext(ctx, options.config);
      const result = await tool.execute(input, codingContext);
      const persisted = await persistLargeOutput({
        output: result.output,
        limits: outputLimits(options.config),
        store: options.outputStore,
        sessionId: codingContext.sessionId,
        runId: codingContext.runId,
        callId: codingContext.callId,
        preferredName: `${tool.name}.txt`,
      });
      if (!persisted.truncated) {
        return result;
      }
      return {
        ...result,
        output: persisted.output,
        metadata: {
          ...result.metadata,
          truncated: true,
          outputPath: persisted.outputPath,
        },
      };
    },
  });
}

/**
 * 执行 工具 `adapter` 模块 定义的 `adaptCodingTools` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `tools`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 * - `options`: 仅作用于 `adaptCodingTools` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function adaptCodingTools(
  tools: readonly AnyCodingTool[],
  options: CodingToolAdapterOptions,
): AnyAgentTool[] {
  return tools.map((tool) => adaptCodingTool(tool, options));
}

function createContext(
  ctx: AgentToolContext,
  config: CodingAgentConfig,
): CodingToolContext {
  return {
    cwd: config.cwd,
    allowedPaths: config.allowed_paths,
    sessionId: readString(ctx.metadata.sessionId) ?? 'default',
    runId: ctx.runId,
    callId: readString(ctx.metadata.toolCallId) ?? ctx.runId,
    abortSignal: ctx.signal,
    agent: ctx,
  };
}

function outputLimits(config: CodingAgentConfig): ToolOutputLimits {
  return {
    maxBytes: config.tool_output.max_bytes,
    maxLines: config.tool_output.max_lines,
    previewLines: config.tool_output.preview_lines,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
