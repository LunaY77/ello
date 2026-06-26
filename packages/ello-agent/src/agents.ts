import {
  generateText,
  type LanguageModel,
} from "ai";
import { AgentContext } from "./context.js";
import { ModelConfig, ToolConfig } from "./config.js";
import { LocalEnvironment, type Environment } from "./environment/index.js";
import { MessageQueue } from "./queue.js";
import { type ModelWrapper, resolveModel } from "./models.js";
import { Toolset, type BaseToolConstructor } from "./toolsets/index.js";

/** createAgent 的输入参数。 */
export interface CreateAgentOptions {
  modelName?: string | null;
  baseUrl?: string | null;
  systemPrompt?: string | null;
  systemPromptTemplateVars?: Record<string, unknown> | null;
  env?: Environment | null;
  modelConfig?: ModelConfig | null;
  toolConfig?: ToolConfig | null;
  modelWrapper?: ModelWrapper | null;
  tools?: BaseToolConstructor[] | null;
  toolsets?: Toolset[] | null;
}

/** AgentRuntime 的构造参数。 */
export interface AgentRuntimeOptions {
  modelName: string;
  baseUrl: string | null;
  systemPrompt: string | null;
  model: LanguageModel;
  env: Environment;
  modelConfig: ModelConfig;
  toolConfig: ToolConfig;
  modelWrapper?: ModelWrapper | null;
  coreToolset?: Toolset | null;
  toolsets?: Toolset[];
}

/**
 * Agent 运行时, 管理 env -> ctx -> model 调用生命周期。
 *
 * 必须通过 enter() 进入后才能调用 run()。后续迁移 toolsets、streaming、
 * session 时继续在此类上扩展, 保持 Python 版 AgentRuntime 的入口形态。
 */
export class AgentRuntime {
  readonly modelName: string;
  readonly baseUrl: string | null;
  readonly systemPrompt: string | null;
  readonly model: LanguageModel;
  readonly env: Environment;
  readonly modelConfig: ModelConfig;
  readonly toolConfig: ToolConfig;
  readonly modelWrapper: ModelWrapper | null;
  readonly coreToolset: Toolset | null;
  readonly toolsets: Toolset[];
  readonly steeringQueue = new MessageQueue();
  readonly followUpQueue = new MessageQueue();
  ctx: AgentContext | null = null;
  private enterCount = 0;

  constructor(options: AgentRuntimeOptions) {
    this.modelName = options.modelName;
    this.baseUrl = options.baseUrl;
    this.systemPrompt = options.systemPrompt;
    this.model = options.model;
    this.env = options.env;
    this.modelConfig = options.modelConfig;
    this.toolConfig = options.toolConfig;
    this.modelWrapper = options.modelWrapper ?? null;
    this.coreToolset = options.coreToolset ?? null;
    this.toolsets = options.toolsets ?? [];
  }

  /** 是否存在需要审批的工具。 */
  get hasApprovalTools(): boolean {
    return this.toolsets.some((toolset) => toolset.hasApprovalTools);
  }

  /** 是否已进入运行时生命周期。 */
  get entered(): boolean {
    return this.enterCount > 0;
  }

  /**
   * 注入 steering 消息, 在当前 turn 完成后生效。
   */
  steer(message: string): void {
    this.steeringQueue.enqueue(message);
  }

  /**
   * 注入 follow-up 消息, 在 agent 即将停止时生效。
   */
  followUp(message: string): void {
    this.followUpQueue.enqueue(message);
  }

  /** 清空所有消息队列。 */
  clearQueues(): void {
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  /**
   * 进入 runtime 生命周期。
   */
  async enter(): Promise<this> {
    if (this.enterCount === 0) {
      await this.env.enter();
      this.ctx = new AgentContext({
        env: this.env,
        modelConfig: this.modelConfig,
        toolConfig: this.toolConfig,
      });
    }
    this.enterCount += 1;
    return this;
  }

  /**
   * 退出 runtime 生命周期。
   */
  async exit(): Promise<void> {
    this.enterCount -= 1;
    if (this.enterCount <= 0) {
      this.enterCount = 0;
      this.ctx = null;
      await this.env.exit();
    }
  }

  /**
   * 执行一轮非流式调用。
   *
   * Args:
   *   prompt: 本轮发送给模型的用户输入。
   *
   * Returns:
   *   Vercel AI SDK generateText 的结果。
   */
  async run(prompt: string): Promise<Awaited<ReturnType<typeof generateText>>> {
    if (!this.entered || this.ctx === null) {
      throw new Error("AgentRuntime must be entered via 'await runtime.enter()' before calling run().");
    }
    if (typeof prompt !== "string") {
      throw new TypeError("prompt must be a string.");
    }

    this.ctx = this.ctx.prepareNewRun();
    const params = {
      model: this.model,
      prompt,
      ...(this.systemPrompt !== null ? { system: this.systemPrompt } : {}),
    };
    return generateText(params);
  }
}

/**
 * 创建 ello agent runtime。
 *
 * Args:
 *   options.modelName: 可选的 model string; 未传入时使用默认模型。
 *   options.baseUrl: 可选的 provider base URL。
 *   options.systemPrompt: 可选系统提示词。
 *   options.env: 可选 Environment; 未传入时使用 LocalEnvironment(process.cwd())。
 *   options.modelConfig: 可选模型配置。
 *   options.toolConfig: 可选工具配置。
 *   options.modelWrapper: 可选模型包装器。
 *   options.tools: 可选 BaseTool 子类序列; 将被组装为核心 Toolset。
 *   options.toolsets: 可选额外 Toolset 序列。
 *
 * Returns:
 *   需要通过 enter() 进入后再调用 run() 的 AgentRuntime。
 */
export function createAgent(options: CreateAgentOptions = {}): AgentRuntime {
  const selection = resolveModel({
    ...(options.modelName !== undefined ? { modelName: options.modelName } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });

  const wrapperContext = {
    modelName: selection.modelName,
    baseUrl: selection.baseUrl,
  };
  const effectiveModel = options.modelWrapper
    ? options.modelWrapper(selection.model, selection.modelName, wrapperContext)
    : selection.model;
  const coreToolset = options.tools?.length ? new Toolset({ tools: options.tools }) : null;
  const allToolsets = [
    ...(coreToolset !== null ? [coreToolset] : []),
    ...(options.toolsets ?? []),
  ];

  return new AgentRuntime({
    modelName: selection.modelName,
    baseUrl: selection.baseUrl,
    systemPrompt: options.systemPrompt ?? null,
    model: effectiveModel,
    env: options.env ?? new LocalEnvironment(),
    modelConfig: options.modelConfig ?? new ModelConfig(),
    toolConfig: options.toolConfig ?? new ToolConfig(),
    modelWrapper: options.modelWrapper ?? null,
    coreToolset,
    toolsets: allToolsets,
  });
}
