import type { CodingAgentConfig } from '../../../config/index.js';
import {
  defineTool,
  type AnyAgentTool,
  type AgentToolContext,
} from '../../engine/index.js';

import type {
  AnyCodingTool,
  CodingTool,
  CodingToolContext,
} from './coding-tool.js';
import {
  persistLargeOutput,
  type ToolOutputLimits,
  type ToolOutputStore,
} from './output-store.js';

export interface CodingToolAdapterOptions {
  readonly config: CodingAgentConfig;
  readonly outputStore: ToolOutputStore;
}

export function adaptCodingTool<TInput>(
  tool: CodingTool<TInput>,
  options: CodingToolAdapterOptions,
): AnyAgentTool {
  return defineTool({
    name: tool.name,
    description: tool.description,
    discovery: tool.discovery,
    input: tool.input,
    approval:
      tool.approval === undefined
        ? undefined
        : (input, ctx) =>
            tool.approval!(input, createContext(ctx, options.config)),
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

export function adaptCodingTools(
  tools: readonly CodingTool[],
  options: CodingToolAdapterOptions,
): AnyAgentTool[] {
  return tools.map((tool) => adaptCodingTool(tool as AnyCodingTool, options));
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
