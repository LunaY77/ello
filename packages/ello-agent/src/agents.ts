import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type Prompt,
  type StepResult,
  tool as aiTool,
  type ToolSet,
} from 'ai';

import { ModelConfig, ToolConfig } from './config.js';
import { AgentContext } from './context.js';
import { LocalEnvironment, type Environment } from './environment/index.js';
import { buildMcpServers, MCPConfigSchema, type MCPConfig } from './mcp.js';
import { type ModelWrapper, resolveModel } from './models.js';
import { MessageQueue } from './queue.js';
import type {
  DeferredToolApprovalRequest,
  DeferredToolRequests,
  DeferredToolResults,
} from './state.js';
import {
  Toolset,
  type BaseToolConstructor,
  type ToolArgs,
  type ToolsetTool,
} from './toolsets/index.js';

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
  modelConfig?: ModelConfig | null;
  toolConfig?: ToolConfig | null;
  modelWrapper?: ModelWrapper | null;
  tools?: BaseToolConstructor[] | null;
  toolsets?: RuntimeToolset[] | null;
  mcpConfig?: MCPConfig | null;
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
  toolsets?: RuntimeToolset[];
}

/** AgentRuntime.run() 的 AI SDK 对齐输入。 */
export type AgentRuntimeRunInput = string | AgentRuntimeGenerateInput;

/** AgentRuntime.run() 允许调用方传入的 generateText 选项。 */
export type AgentRuntimeGenerateInput = Omit<
  Parameters<typeof generateText>[0],
  'model' | 'tools' | 'prompt' | 'messages'
> &
  Prompt & {
    /** Python 兼容: 历史消息, 会被转换为 AI SDK messages。 */
    messageHistory?: ModelMessage[] | null;
    /** Python 兼容: resume 时传入的 deferred tool 结果。 */
    deferredToolResults?: DeferredToolResults | null;
  };

/** AgentRuntime.run() 返回值, 在 AI SDK 结果上补充 Python 兼容字段。 */
export type AgentRuntimeRunResult = Awaited<ReturnType<typeof generateText>> & {
  /** Python AgentRunResult 兼容输出; 普通调用为 text, 审批暂停时为 DeferredToolRequests。 */
  output: string | DeferredToolRequests;
  /** Python AgentRunResult.all_messages() 对齐方法。 */
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
  readonly modelConfig: ModelConfig;
  readonly toolConfig: ToolConfig;
  readonly modelWrapper: ModelWrapper | null;
  readonly coreToolset: Toolset | null;
  readonly toolsets: RuntimeToolset[];
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
    return this.toolsets.some((toolset) => toolset.hasApprovalTools === true);
  }

  /** 是否已进入运行时生命周期。 */
  get entered(): boolean {
    return this.enterCount > 0;
  }

  /**
   * 将 ello Toolset 转换为 Vercel AI SDK ToolSet。
   *
   * 该方法依赖当前 run 的 AgentContext, 因为工具可用性和执行都需要
   * runtime 上下文。PydanticAI 的 ToolsetTool 概念在 TS 版中被桥接为
   * AI SDK 的 `tool({ inputSchema, execute })`。
   */
  async toAiToolSet(): Promise<ToolSet> {
    if (this.ctx === null) {
      return {};
    }

    const result: ToolSet = {};
    const runCtx = { deps: this.ctx };
    for (const toolset of this.toolsets) {
      const tools = await toolset.getTools(runCtx);
      for (const [name, toolDef] of Object.entries(tools)) {
        result[name] = this.createAiTool(toolset, name, toolDef);
      }
    }
    return result;
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
   *   input: prompt 字符串, 或 Vercel AI SDK generateText 的 prompt/messages 选项。
   *
   * Returns:
   *   Vercel AI SDK generateText 的结果。
   */
  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    if (!this.entered || this.ctx === null) {
      throw new Error(
        "AgentRuntime must be entered via 'await runtime.enter()' before calling run().",
      );
    }

    this.ctx = this.ctx.prepareNewRun();
    const approvalToolNames = new Set<string>();
    const toolSets = await this.collectToolSets(approvalToolNames);
    const base = {
      model: this.model,
      tools: toolSets.tools,
      ...(this.systemPrompt !== null ? { system: this.systemPrompt } : {}),
    };
    const steps: Array<StepResult<ToolSet, Record<string, unknown>>> = [];
    const onStepEnd = (step: StepResult<ToolSet, Record<string, unknown>>) => {
      steps.push(step);
    };

    if (typeof input === 'string') {
      const result = await generateText({
        ...base,
        prompt: input,
        onStepEnd,
      });
      return this.wrapRunResult(result, input, steps, approvalToolNames);
    }

    const options = pickGenerateOptions(input);
    const messages = buildMessagesWithResume(options);
    if (options.messages !== undefined) {
      const result = await generateText({
        ...base,
        ...options,
        messages,
        onStepEnd,
      });
      return this.wrapRunResult(result, input, steps, approvalToolNames);
    }

    const result = await generateText({
      ...base,
      ...options,
      prompt: options.prompt,
      onStepEnd,
    });
    return this.wrapRunResult(result, input, steps, approvalToolNames);
  }

  private async collectToolSets(approvalToolNames: Set<string>): Promise<{
    tools: ToolSet;
  }> {
    if (this.ctx === null) {
      return { tools: {} };
    }

    const result: ToolSet = {};
    const runCtx = { deps: this.ctx };
    for (const toolset of this.toolsets) {
      const tools = await toolset.getTools(runCtx);
      for (const [name, toolDef] of Object.entries(tools)) {
        if (toolDef.requiresApproval) {
          approvalToolNames.add(name);
        }
        result[name] = this.createAiTool(toolset, name, toolDef);
      }
    }
    return { tools: result };
  }

  private createAiTool(
    toolset: RuntimeToolset,
    name: string,
    toolDef: ToolsetTool,
  ): ToolSet[string] {
    return aiTool({
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      execute: async (input) => {
        if (toolDef.requiresApproval) {
          return {
            status: 'deferred',
            reason: 'Tool execution requires approval.',
          };
        }
        if (this.ctx === null) {
          throw new Error('AgentRuntime context is not available.');
        }
        return toolset.callTool(
          name,
          input as Record<string, unknown>,
          { deps: this.ctx },
          toolDef,
        );
      },
    });
  }

  private wrapRunResult(
    result: Awaited<ReturnType<typeof generateText>>,
    input: AgentRuntimeRunInput,
    steps: Array<StepResult<ToolSet, Record<string, unknown>>>,
    approvalToolNames: ReadonlySet<string>,
  ): AgentRuntimeRunResult {
    const pending = collectDeferredRequests(steps, approvalToolNames);
    const output = pending !== null ? pending : result.text;
    return Object.assign(result, {
      output,
      allMessages: () => buildAllMessages(input, result),
    });
  }
}

function pickGenerateOptions(input: AgentRuntimeGenerateInput) {
  const inputWithRuntimeFields = input as AgentRuntimeGenerateInput & {
    model?: unknown;
    tools?: unknown;
  };
  const {
    model: _model,
    tools: _tools,
    messageHistory: _messageHistory,
    deferredToolResults: _deferredToolResults,
    ...options
  } = inputWithRuntimeFields;
  return options;
}

function buildMessagesWithResume(
  input: AgentRuntimeGenerateInput,
): ModelMessage[] {
  const baseMessages = [...(input.messageHistory ?? input.messages ?? [])];
  const deferredMessages = buildDeferredResultMessages(
    input.deferredToolResults,
  );
  return [...baseMessages, ...deferredMessages];
}

function buildDeferredResultMessages(
  results: DeferredToolResults | null | undefined,
): ModelMessage[] {
  if (results === null || results === undefined) {
    return [];
  }

  const toolResults = [
    ...Object.entries(results.approvals).map(([toolCallId, approval]) => ({
      toolCallId,
      toolName: 'approval',
      output: normalizeApprovalResult(approval),
    })),
    ...Object.entries(results.calls).map(([toolCallId, output]) => ({
      toolCallId,
      toolName: 'deferred_call',
      output,
    })),
  ];

  if (toolResults.length === 0) {
    return [];
  }

  return [
    {
      role: 'tool',
      content: toolResults.map((result) => ({
        type: 'tool-result' as const,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        output: result.output,
      })),
    },
  ] as ModelMessage[];
}

function normalizeApprovalResult(
  approval: DeferredToolResults['approvals'][string],
): unknown {
  if (typeof approval === 'boolean') {
    return approval ? 'approved' : 'denied';
  }
  return approval.approved
    ? 'approved'
    : `denied${approval.reason ? `: ${approval.reason}` : ''}`;
}

function collectDeferredRequests(
  steps: Array<StepResult<ToolSet, Record<string, unknown>>>,
  approvalToolNames: ReadonlySet<string>,
): DeferredToolRequests | null {
  const approvals = new Map<string, DeferredToolApprovalRequest>();
  for (const step of steps) {
    for (const toolCall of step.toolCalls) {
      if (approvalToolNames.has(toolCall.toolName)) {
        approvals.set(toolCall.toolCallId, {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        });
      }
    }
  }

  if (approvals.size === 0) {
    return null;
  }

  return {
    approvals: [...approvals.values()],
    calls: [],
  };
}

function buildAllMessages(
  input: AgentRuntimeRunInput,
  result: Awaited<ReturnType<typeof generateText>>,
): ModelMessage[] {
  const initialMessages = normalizeInitialMessages(input);
  return [...initialMessages, ...result.responseMessages];
}

function normalizeInitialMessages(input: AgentRuntimeRunInput): ModelMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  const history = input.messageHistory ?? [];
  if (input.messages !== undefined) {
    return [...history, ...input.messages];
  }
  if (Array.isArray(input.prompt)) {
    return [...history, ...input.prompt];
  }
  if (typeof input.prompt === 'string') {
    return [...history, { role: 'user', content: input.prompt }];
  }
  return [...history];
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
