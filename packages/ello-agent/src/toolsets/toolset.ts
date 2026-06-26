import { z, type ZodTypeAny } from "zod";
import type { AgentContext } from "../context.js";
import { ToolHooks, type RunContextLike } from "../hooks.js";
import {
  BaseTool,
  getToolMetadata,
  Instruction,
  type BaseToolConstructor,
  type ToolArgs,
} from "./base.js";

/** Toolset 可执行工具描述。 */
export interface ToolsetTool {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  requiresApproval: boolean;
  maxRetries: number;
}

/** Toolset 构造参数。 */
export interface ToolsetOptions {
  tools: BaseToolConstructor[];
  maxRetries?: number;
  skipUnavailable?: boolean;
  toolsetId?: string | null;
  hooks?: ToolHooks<AgentContext> | null;
}

/**
 * 工具集, 管理一组 BaseTool 的注册、可用性判定和调用。
 *
 * Args:
 *   tools: BaseTool 子类序列。
 *   maxRetries: 工具执行最大重试次数。
 *   skipUnavailable: 为 true 时跳过 isAvailable() 返回 false 的工具。
 *   toolsetId: 可选的唯一标识符。
 *   hooks: 工具前后置 hook。
 */
export class Toolset {
  private readonly maxRetries: number;
  private readonly skipUnavailable: boolean;
  private readonly toolsetId: string | null;
  private readonly hooks: ToolHooks<AgentContext>;
  private readonly toolClasses = new Map<string, BaseToolConstructor>();
  private readonly toolInstances = new Map<string, BaseTool>();
  private readonly toolDefs = new Map<string, ToolsetTool>();

  constructor(options: ToolsetOptions) {
    this.maxRetries = options.maxRetries ?? 3;
    this.skipUnavailable = options.skipUnavailable ?? true;
    this.toolsetId = options.toolsetId ?? null;
    this.hooks = options.hooks ?? new ToolHooks<AgentContext>();

    for (const toolClass of options.tools) {
      const metadata = getToolMetadata(toolClass);
      if (this.toolClasses.has(metadata.name)) {
        throw new Error(`Duplicate tool name: '${metadata.name}'`);
      }
      this.toolClasses.set(metadata.name, toolClass);
    }
  }

  /** 返回工具集唯一标识符。 */
  get id(): string | null {
    return this.toolsetId;
  }

  /** 返回已注册的工具名称列表。 */
  get toolNames(): string[] {
    return [...this.toolClasses.keys()];
  }

  /** 返回是否有任何工具需要审批。 */
  get hasApprovalTools(): boolean {
    return [...this.toolClasses.values()].some(
      (toolClass) => getToolMetadata(toolClass).requiresApproval,
    );
  }

  /**
   * 创建包含指定工具的子集 Toolset。
   *
   * 始终包含 autoInherit=true 的工具。排除带有 excludeTags 中任意 tag 的工具。
   */
  subset(options: {
    toolNames?: string[] | null;
    excludeTags?: ReadonlySet<string> | null;
  } = {}): Toolset {
    const selected: BaseToolConstructor[] = [];
    for (const [name, toolClass] of this.toolClasses) {
      const metadata = getToolMetadata(toolClass);
      if (options.excludeTags && intersects(metadata.tags, options.excludeTags)) {
        continue;
      }
      if (
        metadata.autoInherit ||
        options.toolNames === undefined ||
        options.toolNames === null ||
        options.toolNames.includes(name)
      ) {
        selected.push(toolClass);
      }
    }
    return new Toolset({
      tools: selected,
      maxRetries: this.maxRetries,
      skipUnavailable: this.skipUnavailable,
      hooks: this.hooks,
    });
  }

  /**
   * 获取或创建工具实例。
   */
  getToolInstance(name: string): BaseTool {
    const existing = this.toolInstances.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const toolClass = this.toolClasses.get(name);
    if (toolClass === undefined) {
      throw new Error(`Tool '${name}' not found in toolset`);
    }
    const instance = new toolClass();
    this.toolInstances.set(name, instance);
    return instance;
  }

  /**
   * 返回所有可用工具。
   *
   * 两阶段过滤:
   * 1. 检查基础可用性, 收集能力标签。
   * 2. 过滤被活跃标签 supersede 的工具。
   */
  async getTools(ctx: RunContextLike<AgentContext>): Promise<Record<string, ToolsetTool>> {
    const availableNames = new Set<string>();
    const collectedTags = new Set<string>();

    for (const name of this.toolClasses.keys()) {
      const toolInstance = this.getToolInstance(name);
      if (this.skipUnavailable && !toolInstance.isAvailable(ctx)) {
        continue;
      }
      availableNames.add(name);
      for (const tag of toolInstance.tags) {
        collectedTags.add(tag);
      }
    }

    const tools: Record<string, ToolsetTool> = {};
    for (const name of availableNames) {
      const toolInstance = this.getToolInstance(name);
      if (
        toolInstance.supersededByTags.size > 0 &&
        intersects(toolInstance.supersededByTags, collectedTags)
      ) {
        continue;
      }

      let toolDef = this.toolDefs.get(name);
      if (toolDef === undefined) {
        toolDef = {
          name,
          description: toolInstance.description,
          inputSchema: toolInstance.inputSchema,
          requiresApproval: toolInstance.requiresApproval,
          maxRetries: this.maxRetries,
        };
        this.toolDefs.set(name, toolDef);
      }
      tools[name] = toolDef;
    }
    return tools;
  }

  /**
   * 执行工具调用, 前后执行 hooks。
   */
  async callTool(
    name: string,
    toolArgs: ToolArgs,
    ctx: RunContextLike<AgentContext>,
    _tool?: ToolsetTool,
  ): Promise<unknown> {
    if (!this.toolClasses.has(name)) {
      return `Error: tool '${name}' not found`;
    }

    const toolInstance = this.getToolInstance(name);
    const preArgs = await this.hooks.runPre(ctx, name, toolArgs);
    let parsed: ToolArgs;
    try {
      parsed = parseToolArgs(toolInstance.inputSchema, preArgs);
    } catch (error) {
      return `Error calling tool ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }

    let result: unknown;
    try {
      result = await toolInstance.call(ctx, parsed);
    } catch (error) {
      return `Error calling tool ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.hooks.runPost(ctx, name, result);
  }

  /**
   * 收集所有工具的指令, 按 group 去重。
   */
  async getInstructions(ctx: RunContextLike<AgentContext>): Promise<string | null> {
    const availableNames: string[] = [];
    const collectedTags = new Set<string>();

    for (const name of this.toolClasses.keys()) {
      const toolInstance = this.getToolInstance(name);
      if (this.skipUnavailable && !toolInstance.isAvailable(ctx)) {
        continue;
      }
      availableNames.push(name);
      for (const tag of toolInstance.tags) {
        collectedTags.add(tag);
      }
    }

    const instructions = new Map<string, string>();
    for (const name of availableNames) {
      const toolInstance = this.getToolInstance(name);
      if (
        toolInstance.supersededByTags.size > 0 &&
        intersects(toolInstance.supersededByTags, collectedTags)
      ) {
        continue;
      }

      const result = await toolInstance.getInstruction(ctx);
      if (result === null) {
        continue;
      }
      const group = result instanceof Instruction ? result.group : toolInstance.name;
      const content = result instanceof Instruction ? result.content : result;
      if (!instructions.has(group)) {
        instructions.set(group, `<tool-instruction name="${escapeXml(group)}">${content}</tool-instruction>`);
      }
    }

    return instructions.size > 0 ? [...instructions.values()].join("\n") : null;
  }
}

function parseToolArgs(schema: ZodTypeAny, args: ToolArgs): ToolArgs {
  const parsed = schema.parse(args);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool input schema must parse to an object.");
  }
  return parsed as ToolArgs;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) {
      return true;
    }
  }
  return false;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 空工具参数 schema。 */
export const EmptyToolArgsSchema = z.object({}).passthrough();
