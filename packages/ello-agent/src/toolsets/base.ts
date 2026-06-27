import { z, type ZodTypeAny } from 'zod';

import type { AgentContext } from '../context.js';
import type { RunContextLike } from '../hooks.js';

/** 工具参数字典类型。 */
export type ToolArgs = Record<string, unknown>;

/** 工具运行上下文类型。 */
export type ToolRunContext = RunContextLike<AgentContext>;

/** BaseTool 子类构造器。 */
export type BaseToolConstructor<TTool extends BaseTool = BaseTool> = {
  new (): TTool;
  toolName: string;
  description: string;
  tags?: ReadonlySet<string>;
  supersededByTags?: ReadonlySet<string>;
  autoInherit?: boolean;
  requiresApproval?: boolean;
  inputSchema?: ZodTypeAny;
};

/**
 * 工具指令, 支持按 group 跨工具去重。
 *
 * 多个工具返回相同 group 的 Instruction 时只保留第一个, 用于 delegate
 * 等场景: 多个 delegate tool 共享同一条 instruction。
 */
export class Instruction {
  /** 指令去重分组。 */
  readonly group: string;

  /** 指令文本内容。 */
  readonly content: string;

  constructor(group: string, content: string) {
    this.group = group;
    this.content = content;
  }
}

/**
 * 工具抽象基类。
 *
 * 子类定义静态 toolName/description, 实现 call() 方法, 可选覆写
 * isAvailable() 和 getInstruction()。TS 版使用 Zod inputSchema 显式描述
 * 参数。
 */
export abstract class BaseTool {
  /** 工具名称。 */
  static toolName: string;

  /** 工具描述。 */
  static description: string;

  /** 能力标签。其他工具可声明被这些标签 supersede。 */
  static tags: ReadonlySet<string> = new Set();

  /** 当这些标签中的任意一个处于活跃状态时, 此工具自动隐藏。 */
  static supersededByTags: ReadonlySet<string> = new Set();

  /** 是否自动被 subagent 继承。 */
  static autoInherit = false;

  /** 是否需要人工审批才能执行。 */
  static requiresApproval = false;

  /** 工具输入参数 schema。 */
  static inputSchema: ZodTypeAny = z.object({}).passthrough();

  /** 工具名称。 */
  get name(): string {
    return getToolMetadata(this.constructor as BaseToolConstructor).name;
  }

  /** 工具描述。 */
  get description(): string {
    return getToolMetadata(this.constructor as BaseToolConstructor).description;
  }

  /** 能力标签。 */
  get tags(): ReadonlySet<string> {
    return getToolMetadata(this.constructor as BaseToolConstructor).tags;
  }

  /** 被哪些标签 supersede。 */
  get supersededByTags(): ReadonlySet<string> {
    return getToolMetadata(this.constructor as BaseToolConstructor)
      .supersededByTags;
  }

  /** 是否自动被 subagent 继承。 */
  get autoInherit(): boolean {
    return getToolMetadata(this.constructor as BaseToolConstructor).autoInherit;
  }

  /** 是否需要人工审批才能执行。 */
  get requiresApproval(): boolean {
    return getToolMetadata(this.constructor as BaseToolConstructor)
      .requiresApproval;
  }

  /** 工具输入参数 schema。 */
  get inputSchema(): ZodTypeAny {
    return getToolMetadata(this.constructor as BaseToolConstructor).inputSchema;
  }

  /**
   * 判断工具在当前上下文中是否可用。
   *
   * Args:
   *   ctx: 工具运行上下文。
   *
   * Returns:
   *   true 表示工具当前可用。
   */
  isAvailable(_ctx: ToolRunContext): boolean {
    return true;
  }

  /**
   * 获取此工具的动态指令。
   *
   * Returns:
   *   返回 string 时以工具名去重; 返回 Instruction 时按 group 去重。
   */
  async getInstruction(
    _ctx: ToolRunContext,
  ): Promise<string | Instruction | null> {
    return null;
  }

  /**
   * 执行工具逻辑。
   *
   * Args:
   *   ctx: 工具运行上下文。
   *   args: 已通过 inputSchema 校验的参数字典。
   */
  abstract call(ctx: ToolRunContext, args: ToolArgs): Promise<unknown>;
}

/** 函数式工具定义参数。 */
export interface ToolDecoratorOptions {
  name: string;
  description: string;
  inputSchema?: ZodTypeAny;
  tags?: ReadonlySet<string>;
  supersededByTags?: ReadonlySet<string>;
  autoInherit?: boolean;
  requiresApproval?: boolean;
}

/** 工具函数类型。 */
export type ToolFunction = (
  ctx: ToolRunContext,
  args: ToolArgs,
) => Promise<unknown>;

/**
 * 函数式工具定义 helper。
 *
 * 将异步函数转换为 BaseTool 子类。TS 无法可靠区分
 * async 函数和返回 Promise 的函数, 因此在 call() 时校验返回值是否为 Promise。
 */
export function tool(
  options: ToolDecoratorOptions,
  fn: ToolFunction,
): BaseToolConstructor {
  if (!isAsyncFunction(fn)) {
    throw new TypeError('tool() requires an async function.');
  }

  class FunctionTool extends BaseTool {
    static override toolName = options.name;
    static override description = options.description;
    static override tags = options.tags ?? new Set<string>();
    static override supersededByTags =
      options.supersededByTags ?? new Set<string>();
    static override autoInherit = options.autoInherit ?? false;
    static override requiresApproval = options.requiresApproval ?? false;
    static override inputSchema =
      options.inputSchema ?? z.object({}).passthrough();

    async call(ctx: ToolRunContext, args: ToolArgs): Promise<unknown> {
      const result = fn(ctx, args);
      if (!isPromiseLike(result)) {
        throw new TypeError(
          'tool() requires a function that returns a Promise.',
        );
      }
      return result;
    }
  }

  Object.defineProperty(FunctionTool, 'name', { value: options.name });
  return FunctionTool;
}

/**
 * 读取工具类元数据并填充默认值。
 */
export function getToolMetadata(toolClass: BaseToolConstructor): {
  name: string;
  description: string;
  tags: ReadonlySet<string>;
  supersededByTags: ReadonlySet<string>;
  autoInherit: boolean;
  requiresApproval: boolean;
  inputSchema: ZodTypeAny;
} {
  const name = toolClass.toolName;
  const description = toolClass.description;
  if (!name) {
    throw new Error('Tool class must define static toolName.');
  }
  if (!description) {
    throw new Error(`Tool ${name} must define static description.`);
  }
  return {
    name,
    description,
    tags: toolClass.tags ?? new Set<string>(),
    supersededByTags: toolClass.supersededByTags ?? new Set<string>(),
    autoInherit: toolClass.autoInherit ?? false,
    requiresApproval: toolClass.requiresApproval ?? false,
    inputSchema: toolClass.inputSchema ?? z.object({}).passthrough(),
  };
}

function isAsyncFunction(value: unknown): boolean {
  return (
    typeof value === 'function' && value.constructor.name === 'AsyncFunction'
  );
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}
