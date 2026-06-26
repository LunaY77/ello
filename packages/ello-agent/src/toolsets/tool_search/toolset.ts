import { z } from "zod";
import type { AgentContext } from "../../context.js";
import { Toolset, type ToolsetTool } from "../toolset.js";
import type { SearchStrategy } from "./strategies/base.js";
import { BM25SearchStrategy } from "./strategies/bm25.js";
import { KeywordSearchStrategy } from "./strategies/keyword.js";

/**
 * 获取默认搜索策略: BM25 可用时使用 BM25, 否则回退到关键词。
 */
export function getDefaultStrategy(): SearchStrategy {
  return new BM25SearchStrategy() ?? new KeywordSearchStrategy();
}

/**
 * ToolSearchToolset: 搜索后动态添加工具到 model tool list。
 */
export class ToolSearchToolset {
  private readonly source: Toolset;
  private readonly strategy: SearchStrategy;
  private readonly minScore: number;
  private readonly maxResults: number;
  private readonly loadedNames = new Set<string>();
  private indexBuilt = false;

  constructor(
    sourceToolset: Toolset,
    options: {
      strategy?: SearchStrategy | null;
      minScore?: number;
      maxResults?: number;
    } = {},
  ) {
    this.source = sourceToolset;
    this.strategy = options.strategy ?? getDefaultStrategy();
    this.minScore = options.minScore ?? 0.3;
    this.maxResults = options.maxResults ?? 10;
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexBuilt) {
      return;
    }
    const tools = this.source.toolNames.map((name) => [
      name,
      this.source.getToolInstance(name).description,
    ]) as Array<[string, string]>;
    await this.strategy.buildIndex(tools);
    this.indexBuilt = true;
  }

  async getTools(ctx: { deps: AgentContext }): Promise<Record<string, ToolsetTool>> {
    const tools: Record<string, ToolsetTool> = {
      search_tools: {
        name: "search_tools",
        description: "Search for available tools by keyword. Matched tools become available in the next turn.",
        inputSchema: z.object({ query: z.string() }),
        requiresApproval: false,
        maxRetries: 3,
      },
    };
    const sourceTools = await this.source.getTools(ctx);
    for (const name of this.loadedNames) {
      if (sourceTools[name]) {
        tools[name] = sourceTools[name];
      }
    }
    return tools;
  }

  async callTool(name: string, toolArgs: Record<string, unknown>, ctx: { deps: AgentContext }, tool?: ToolsetTool): Promise<unknown> {
    if (name === "search_tools") {
      const parsed = z.object({ query: z.string() }).parse(toolArgs);
      return this.searchTools(parsed.query);
    }
    return this.source.callTool(name, toolArgs, ctx, tool);
  }

  async searchTools(query: string): Promise<string> {
    await this.ensureIndex();
    const candidates = this.source.toolNames.map((name) => [
      name,
      this.source.getToolInstance(name).description,
    ]) as Array<[string, string]>;
    const results = await this.strategy.search(query, candidates, this.maxResults);
    const filtered = results.filter(([score]) => score >= this.minScore);
    if (filtered.length === 0) {
      return "No matching tools found. Try different keywords.";
    }

    const loaded: string[] = [];
    for (const [, name, desc] of filtered) {
      this.loadedNames.add(name);
      loaded.push(`- ${name}: ${desc}`);
    }

    return `Found and loaded ${loaded.length} tools (available next turn):\n${loaded.join("\n")}`;
  }
}
