import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type Prompt,
  type ToolSet,
} from 'ai';

import { ModelConfig, ToolConfig } from './config.js';
import { AgentContext } from './context.js';
import { LocalEnvironment, type Environment } from './environment/index.js';
import { buildMcpServers, MCPConfigSchema, type MCPConfig } from './mcp.js';
import type { ProviderHooks } from './model/types.js';
import { type ModelWrapper, resolveModel } from './models.js';
import { resolveModelSettings, type ModelSettings } from './presets.js';
import { MessageQueue } from './queue.js';
import { runAgentLoop } from './runtime/agent-loop.js';
import { renderSystemPrompt } from './runtime/prompt-template.js';
import { collectRuntimeTools } from './runtime/tool-execution.js';
import type { SessionStorage } from './session/index.js';
import type { DeferredToolRequests } from './state.js';
import { AgentStreamer } from './streaming/index.js';
import {
  Toolset,
  type BaseToolConstructor,
  type ToolArgs,
  type ToolsetTool,
} from './toolsets/index.js';
import { applyModelWrapper } from './wrappers.js';

const DEFAULT_SYSTEM_PROMPT = `# System

You are ello, a helpful AI assistant.

You have access to tools that let you interact with the user's environment. Use them proactively when relevant to the task.

{% if instructions %}
## Additional Instructions

{{ instructions }}
{% endif %}

## Principles

- Be concise and direct. Avoid unnecessary preambles or repetition.
- When asked to perform a task, do it rather than explaining how to do it.
- If a tool call fails, analyze the error and retry with a corrected approach before asking the user for help.
- Prefer showing results (file contents, command output) over describing what you found.
- When multiple steps are needed, proceed through them without asking for confirmation at each step unless the action is destructive or ambiguous.

## Tool Usage

- Use tools to gather information before answering questions about the environment (files, directories, running processes).
- When reading files, check the output before summarizing - don't assume content.
- When executing commands, use appropriate timeouts and handle errors gracefully.
- For file modifications, read the current content first to understand context.

## Communication

- Match the user's language. If they write in Chinese, respond in Chinese. If in English, respond in English.
- Keep responses focused on the task. Don't add unsolicited advice or warnings unless there's a genuine risk.
- When reporting results, lead with the outcome, then provide details if needed.

## Context Management

- You are operating within a managed context window. If you notice the conversation is getting long and complex, focus on the most recent task rather than re-explaining earlier context.
- Runtime context (time, run ID, model configuration) is injected automatically - use it when relevant but don't echo it back to the user.
`;

/** AgentRuntime 可接收的工具集结构。 */
export interface RuntimeToolset {
  readonly hasApprovalTools?: boolean;
  getTools(ctx: { deps: AgentContext }): Promise<Record<string, ToolsetTool>>;
  callTool(
    name: string,
    toolArgs: ToolArgs,
    ctx: { deps: AgentContext },
    tool?: ToolsetTool,
  ): Promise<unknown>;
}

/** createAgent 的输入参数。 */
export interface CreateAgentOptions {
  modelName?: string | null;
  baseUrl?: string | null;
  systemPrompt?: string | null;
  systemPromptTemplateVars?: Record<string, unknown> | null;
  env?: Environment | null;
  session?: SessionStorage | null;
  modelConfig?: ModelConfig | null;
  toolConfig?: ToolConfig | null;
  modelWrapper?: ModelWrapper | null;
  tools?: BaseToolConstructor[] | null;
  toolsets?: RuntimeToolset[] | null;
  mcpConfig?: MCPConfig | null;
  compact?: boolean;
  modelSettings?: string | ModelSettings | null;
  summaryModel?: LanguageModel | null;
  providerHooks?: ProviderHooks | null;
}

/** AgentRuntime 的构造参数。 */
export interface AgentRuntimeOptions {
  modelName: string;
  baseUrl: string | null;
  systemPrompt: string | null;
  model: LanguageModel;
  env: Environment;
  session?: SessionStorage | null;
  modelConfig: ModelConfig;
  toolConfig: ToolConfig;
  modelSettings?: ModelSettings | null;
  compact?: boolean;
  modelWrapper?: ModelWrapper | null;
  coreToolset?: Toolset | null;
  toolsets?: RuntimeToolset[];
  summaryModel?: LanguageModel | null;
  providerHooks?: ProviderHooks | null;
}

/** AgentRuntime.run() 的 AI SDK 对齐输入。 */
export type AgentRuntimeRunInput = string | AgentRuntimeGenerateInput;

/** AgentRuntime.run() 允许调用方传入的 generateText 选项。 */
export type AgentRuntimeGenerateInput = Omit<
  Parameters<typeof generateText>[0],
  'model' | 'tools'
> &
  Prompt;

/** AgentRuntime.run() 返回值。 */
export type AgentRuntimeRunResult = Awaited<ReturnType<typeof generateText>> & {
  output: string | DeferredToolRequests;
  /** 返回本轮调用的完整消息。 */
  allMessages(): ModelMessage[];
};

/**
 * Agent 运行时, 管理 env -> ctx -> model 调用生命周期。
 *
 * 必须通过 enter() 进入后才能调用 run()。后续扩展 toolsets、streaming、
 * session 时继续在此类上扩展, 保持 AgentRuntime 的统一入口形态。
 */
export class AgentRuntime {
  readonly modelName: string;
  readonly baseUrl: string | null;
  readonly systemPrompt: string | null;
  readonly model: LanguageModel;
  readonly env: Environment;
  readonly session: SessionStorage | null;
  readonly modelConfig: ModelConfig;
  readonly toolConfig: ToolConfig;
  readonly modelSettings: ModelSettings | null;
  readonly compact: boolean;
  readonly modelWrapper: ModelWrapper | null;
  readonly coreToolset: Toolset | null;
  readonly toolsets: RuntimeToolset[];
  readonly summaryModel: LanguageModel | null;
  readonly providerHooks: ProviderHooks | null;
  readonly steeringQueue = new MessageQueue();
  readonly followUpQueue = new MessageQueue();
  ctx: AgentContext | null = null;
  private enterCount = 0;
  private enterLock: Promise<void> = Promise.resolve();

  constructor(options: AgentRuntimeOptions) {
    this.modelName = options.modelName;
    this.baseUrl = options.baseUrl;
    this.systemPrompt = options.systemPrompt;
    this.model = options.model;
    this.env = options.env;
    this.session = options.session ?? null;
    this.modelConfig = options.modelConfig;
    this.toolConfig = options.toolConfig;
    this.modelSettings = options.modelSettings ?? null;
    this.compact = options.compact ?? false;
    this.modelWrapper = options.modelWrapper ?? null;
    this.coreToolset = options.coreToolset ?? null;
    this.toolsets = options.toolsets ?? [];
    this.summaryModel = options.summaryModel ?? null;
    this.providerHooks = options.providerHooks ?? null;
  }

  /** 是否存在需要审批的工具。 */
  get hasApprovalTools(): boolean {
    return this.toolsets.some((toolset) => toolset.hasApprovalTools === true);
  }

  /** 是否已进入运行时生命周期。 */
  get entered(): boolean {
    return this.enterCount > 0;
  }

  /** 当前进入计数, 主要用于测试和调试嵌套生命周期。 */
  get enterCountValue(): number {
    return this.enterCount;
  }

  /**
   * 将 ello Toolset 转换为 Vercel AI SDK ToolSet。
   *
   * 该方法依赖当前 run 的 AgentContext, 因为工具可用性和执行都需要
   * runtime 上下文。PydanticAI 的 ToolsetTool 概念在 TS 版中被桥接为
   * AI SDK 的 `tool({ inputSchema, execute })`。
   */
  async toAiToolSet(): Promise<ToolSet> {
    return collectRuntimeTools({ ctx: this.ctx, toolsets: this.toolsets });
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
    await this.withEnterLock(async () => {
      if (this.enterCount === 0) {
        await this.env.enter();
        this.ctx = new AgentContext({
          env: this.env,
          modelConfig: this.modelConfig,
          toolConfig: this.toolConfig,
        });
      }
      this.enterCount += 1;
    });
    return this;
  }

  /**
   * 退出 runtime 生命周期。
   */
  async exit(): Promise<void> {
    await this.withEnterLock(async () => {
      this.enterCount -= 1;
      if (this.enterCount <= 0) {
        this.enterCount = 0;
        this.ctx = null;
        await this.env.exit();
      }
    });
  }

  /**
   * 执行一轮非流式调用。
   *
   * Args:
   *   input: prompt 字符串, 或 Vercel AI SDK generateText 的 prompt/messages 选项。
   *
   * Returns:
   *   Vercel AI SDK generateText 的结果。
   */
  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    const stream = this.stream(input);
    for await (const _event of stream) {
      // consume stream to completion
    }
    return stream.result();
  }

  /** 执行一轮真实流式调用。 */
  stream(input: AgentRuntimeRunInput): AgentStreamer<AgentRuntimeRunResult> {
    const streamer = new AgentStreamer<AgentRuntimeRunResult>();
    streamer.addTask(runAgentLoop(this, input, streamer));
    return streamer;
  }

  get modelSettingsValue(): ModelSettings | null {
    return this.modelSettings;
  }

  private async withEnterLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.enterLock;
    let release!: () => void;
    this.enterLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
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
    ...(options.modelName !== undefined
      ? { modelName: options.modelName }
      : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });

  const wrapperContext = {
    modelName: selection.modelName,
    baseUrl: selection.baseUrl,
  };
  const effectiveModel = options.modelWrapper
    ? options.modelWrapper(selection.model, selection.modelName, wrapperContext)
    : selection.model;
  return buildAgentRuntime(selection, effectiveModel, options);
}

/**
 * 创建 ello agent runtime, 支持异步 model wrapper。
 *
 * Args:
 *   options: createAgent 同样的配置项。
 *
 * Returns:
 *   已完成 model wrapper 解析的 AgentRuntime。
 */
export async function createAgentAsync(
  options: CreateAgentOptions = {},
): Promise<AgentRuntime> {
  const selection = resolveModel({
    ...(options.modelName !== undefined
      ? { modelName: options.modelName }
      : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });

  const wrapperContext = {
    modelName: selection.modelName,
    baseUrl: selection.baseUrl,
  };
  const effectiveModel = await applyModelWrapper(
    options.modelWrapper ?? null,
    selection.model,
    selection.modelName,
    wrapperContext,
  );
  return buildAgentRuntime(selection, effectiveModel, options);
}

function buildAgentRuntime(
  selection: {
    modelName: string;
    baseUrl: string | null;
  },
  effectiveModel: LanguageModel,
  options: CreateAgentOptions,
): AgentRuntime {
  const effectiveModelSettings = resolveModelSettings(options.modelSettings);
  const coreToolset = options.tools?.length
    ? new Toolset({ tools: options.tools })
    : null;
  const allToolsets = [
    ...(coreToolset !== null ? [coreToolset] : []),
    ...(options.toolsets ?? []),
  ];
  if (options.mcpConfig !== undefined && options.mcpConfig !== null) {
    allToolsets.push(
      ...buildMcpServers(MCPConfigSchema.parse(options.mcpConfig)),
    );
  }

  return new AgentRuntime({
    modelName: selection.modelName,
    baseUrl: selection.baseUrl,
    systemPrompt: renderSystemPrompt({
      template: options.systemPrompt ?? null,
      templateVars: options.systemPromptTemplateVars ?? null,
      defaultTemplate: DEFAULT_SYSTEM_PROMPT,
    }),
    model: effectiveModel,
    env: options.env ?? new LocalEnvironment(),
    session: options.session ?? null,
    modelConfig: options.modelConfig ?? new ModelConfig(),
    toolConfig: options.toolConfig ?? new ToolConfig(),
    modelSettings: effectiveModelSettings,
    compact: options.compact ?? false,
    modelWrapper: options.modelWrapper ?? null,
    coreToolset,
    toolsets: allToolsets,
    summaryModel: options.summaryModel ?? null,
    providerHooks: options.providerHooks ?? null,
  });
}
