import { z } from 'zod';

import type { AgentContext } from '../../context.js';
import type { RunContextLike } from '../../hooks.js';
import { Toolset, type ToolsetTool, type ToolArgs } from '../index.js';
import type { SearchStrategy } from '../tool_search/index.js';
import { getDefaultStrategy } from '../tool_search/index.js';

/** search_tools 工具参数 schema。 */
export const ProxySearchToolsArgsSchema = z.object({
  query: z.string().describe('Search query for finding tools.'),
});

/** call_tool 工具参数 schema。 */
export const ProxyCallToolArgsSchema = z.object({
  toolName: z.string().describe('Name of the tool to call.'),
  arguments: z
    .string()
    .default('{}')
    .describe('JSON string of tool arguments.'),
});

/** ToolProxyToolset 构造参数。 */
export interface ToolProxyToolsetOptions {
  strategy?: SearchStrategy | null;
  minScore?: number;
  maxResults?: number;
}

/**
 * 代理型工具集: 始终只暴露 search_tools 和 call_tool 两个工具。
 *
 * model 通过 search_tools 发现工具, 通过 call_tool 执行工具。
 * 工具 schema 列表固定, 用于提升 prompt cache hit。
 */
export class ToolProxyToolset extends Toolset {
  private readonly source: Toolset;
  private readonly strategy: SearchStrategy;
  private readonly minScore: number;
  private readonly maxResults: number;
  private indexBuilt = false;

  constructor(sourceToolset: Toolset, options: ToolProxyToolsetOptions = {}) {
    super({ tools: [] });
    this.source = sourceToolset;
    this.strategy = options.strategy ?? getDefaultStrategy();
    this.minScore = options.minScore ?? 0.3;
    this.maxResults = options.maxResults ?? 10;
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexBuilt) {
      return;
    }
    await this.strategy.buildIndex(this.candidates);
    this.indexBuilt = true;
  }

  private get candidates(): Array<[string, string]> {
    return this.source.toolNames.map((name) => [
      name,
      this.source.getToolInstance(name).description,
    ]);
  }

  override async getTools(
    _ctx: RunContextLike<AgentContext>,
  ): Promise<Record<string, ToolsetTool>> {
    return {
      search_tools: {
        name: 'search_tools',
        description: 'Search for available tools by keyword.',
        inputSchema: ProxySearchToolsArgsSchema,
        requiresApproval: false,
        maxRetries: 3,
      },
      call_tool: {
        name: 'call_tool',
        description: 'Call a tool by name with JSON arguments.',
        inputSchema: ProxyCallToolArgsSchema,
        requiresApproval: this.source.hasApprovalTools,
        maxRetries: 3,
      },
    };
  }

  override async callTool(
    name: string,
    toolArgs: ToolArgs,
    ctx: RunContextLike<AgentContext>,
    _tool?: ToolsetTool,
  ): Promise<unknown> {
    if (name === 'search_tools') {
      const parsed = ProxySearchToolsArgsSchema.safeParse(toolArgs);
      if (!parsed.success) {
        return `Error calling tool search_tools: ${parsed.error.message}`;
      }
      return this.searchTools(parsed.data.query);
    }
    if (name === 'call_tool') {
      const parsed = ProxyCallToolArgsSchema.safeParse(toolArgs);
      if (!parsed.success) {
        return `Error calling tool call_tool: ${parsed.error.message}`;
      }
      return this.callSourceTool(
        parsed.data.toolName,
        parsed.data.arguments,
        ctx,
      );
    }
    return `Error: ${name} not found`;
  }

  /** 搜索可用工具。 */
  async searchTools(query: string): Promise<string> {
    await this.ensureIndex();
    const results = await this.strategy.search(
      query,
      this.candidates,
      this.maxResults,
    );
    const filtered = results.filter(([score]) => score >= this.minScore);
    if (filtered.length === 0) {
      return 'No matching tools found.';
    }
    return (
      'Available tools:\n' +
      filtered.map(([, name, desc]) => `- ${name}: ${desc}`).join('\n')
    );
  }

  private async callSourceTool(
    toolName: string,
    rawArguments: string,
    ctx: RunContextLike<AgentContext>,
  ): Promise<string> {
    if (!this.source.toolNames.includes(toolName)) {
      return `Error: Tool '${toolName}' not found.`;
    }

    let args: Record<string, unknown>;
    try {
      args = rawArguments
        ? (JSON.parse(rawArguments) as Record<string, unknown>)
        : {};
    } catch (error) {
      return `Error: Invalid JSON arguments: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    const sourceTools = await this.source.getTools(ctx);
    const tool = sourceTools[toolName];
    if (tool === undefined) {
      return `Error: Tool '${toolName}' not available in current context.`;
    }

    const result = await this.source.callTool(toolName, args, ctx, tool);
    return result === null || result === undefined ? '' : String(result);
  }
}
