import { randomUUID } from 'node:crypto';

import { AiSdkModelAdapter } from '../adapters/ai-sdk.js';
import { normalizeAgentError } from '../public/errors.js';
import type { AgentStreamEvent } from '../public/events.js';
import type {
  Agent,
  AgentEnvironment,
  AgentExtension,
  AgentInput,
  AgentMessage,
  AgentModelRequest,
  AgentModelResponse,
  AgentRunContext,
  AgentRunDiagnostics,
  AgentRunOptions,
  AgentRunResult,
  AgentRunState,
  AgentSessionExtension,
  AgentStream,
  AgentToolCall,
  AgentTrace,
  AgentTurnDiagnostics,
  ContextDiagnostics,
  CreateAgentOptions,
  DeferredRunResults,
  ModelAdapter,
  ModelCallPlan,
  QueueDrainDiagnostic,
} from '../public/types.js';

import { diffNewMessages, normalizeInput } from './messages.js';
import {
  createEnvironmentContextSource,
  createStateContextSource,
  DefaultModelCallPlanner,
} from './planner.js';
import { AgentRunControl } from './run-control.js';
import { AgentEventStream } from './stream.js';
import { buildToolSet } from './tool-runner.js';
import { ToolScheduler } from './tool-scheduler.js';
import { addUsage, createEmptyUsage } from './usage.js';

type LoopStopReason =
  | 'natural-completed'
  | 'max-turns'
  | 'waiting-approval'
  | 'interrupted'
  | 'no-progress'
  | 'error';

type LoopDecision =
  | { readonly type: 'continue'; readonly reason: string }
  | { readonly type: 'stop'; readonly reason: LoopStopReason };

interface ExecuteTurnResult {
  readonly response?: AgentModelResponse;
  readonly diagnostics: AgentTurnDiagnostics;
  readonly newMessages: AgentMessage[];
  readonly toolCalls: AgentToolCall[];
  readonly stopReason?: LoopStopReason;
}

/**
 * Agent 具体实现。
 *
 * ElloAgent 负责把 public API 组合成完整运行流程：
 * 1. 规范化输入消息；
 * 2. 注入 instructions、environment instructions 和 session 历史；
 * 3. 执行 extension hooks；
 * 4. 将 AgentTool 转成 AI SDK ToolSet；
 * 5. 通过 ModelAdapter 进行流式模型调用；
 * 6. 汇总 AgentRunResult，并持久化 session。
 *
 * Args:
 *   config: createAgent() 传入的完整配置。
 */
export class ElloAgent implements Agent {
  private readonly environment: AgentEnvironment;
  private readonly extensions: readonly AgentExtension[];
  private readonly modelAdapter: ModelAdapter;
  private readonly observerToolCalls = new Map<string, AgentToolCall>();
  private setupDone = false;

  constructor(private readonly config: CreateAgentOptions) {
    this.environment = config.environment ?? {};
    this.extensions = config.extensions ?? [];
    this.modelAdapter = config.modelAdapter ?? new AiSdkModelAdapter();
  }

  async run(
    input: AgentInput,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const stream = this.stream(input, options);
    for await (const _event of stream) {
      // consume stream to completion
    }
    return stream.final;
  }

  /**
   * 创建流式 run。
   *
   * Args:
   *   input: AgentInput。
   *   options: 本次 run 的临时配置。
   *
   * Returns:
   *   AgentStream。调用方可消费事件，也可直接 await stream.final。
   */
  stream(input: AgentInput, options: AgentRunOptions = {}): AgentStream {
    const abortController = new AbortController();
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          'abort',
          () => abortController.abort(options.signal?.reason),
          { once: true },
        );
      }
    }
    const stream = new AgentEventStream(abortController);
    void this.execute(input, options, abortController.signal, stream);
    return stream;
  }

  /**
   * 恢复一个暂停 run。
   *
   * 当前 public 控制面保持窄接口：产品层提供 deferred payload，core
   * 仍复用同一条 stream 执行路径。这样 approval resume 可以进入 Agent
   * 生命周期，而不再停留在 UI 假动作。
   */
  resume(
    deferred: NonNullable<AgentRunOptions['resume']>,
    options: AgentRunOptions = {},
  ): AgentStream {
    return this.stream({ messages: [] }, { ...options, resume: deferred });
  }

  /**
   * 释放扩展和环境资源。
   *
   * Returns:
   *   所有 teardown/close 完成后 resolve。
   */
  async close(): Promise<void> {
    for (const extension of [...this.extensions].reverse()) {
      await extension.teardown?.();
    }
    await this.environment.close?.();
  }

  private async execute(
    input: AgentInput,
    options: AgentRunOptions,
    signal: AbortSignal,
    stream: AgentEventStream,
  ): Promise<void> {
    const runId = randomUUID();
    const metadata = {
      ...(this.config.metadata ?? {}),
      ...(options.metadata ?? {}),
      ...(options.sessionId !== undefined
        ? { sessionId: options.sessionId }
        : {}),
    };
    const state: AgentRunState = {
      messages: [] as AgentMessage[],
      budget: {},
      turn: 0,
      queueDiagnostics: [],
    };
    const trace: AgentTrace = {
      events: [] as AgentStreamEvent[],
      metadata: {},
    };
    const ctx: AgentRunContext = {
      runId,
      agentName: this.config.name ?? 'agent',
      ...(options.sessionId !== undefined
        ? { sessionId: options.sessionId }
        : {}),
      input,
      context:
        options.context ??
        (typeof input === 'object' && !Array.isArray(input)
          ? input.context
          : undefined),
      options,
      environment: this.environment,
      metadata,
      signal,
      state,
      trace,
    };

    try {
      await this.setup();
      await this.emit({ type: 'run.started', runId }, stream, ctx);
      for (const extension of this.extensions) {
        await extension.beforeRun?.(ctx);
      }

      const runControl = new AgentRunControl(runId);
      const sessionMessages = await this.loadSessionMessages(options.sessionId);
      for (const message of sessionMessages) {
        runControl.sessionQueue.push(message);
      }
      for (const message of normalizeInput(input)) {
        runControl.pushInput(message);
      }
      for (const message of options.messages ?? []) {
        runControl.pushInput(message);
      }

      const toolCalls: AgentToolCall[] = [];
      const tools = buildToolSet({
        tools: this.config.tools ?? [],
      });
      const toolScheduler = new ToolScheduler({
        runId,
        tools: this.config.tools ?? [],
        environment: this.environment,
        metadata,
      });
      const contextSources = [
        createStateContextSource(),
        createEnvironmentContextSource(),
        ...(this.config.context ?? []),
      ];
      if (this.config.memory !== undefined) {
        let retrieved = false;
        let cached = [] as Awaited<
          ReturnType<NonNullable<CreateAgentOptions['memory']>['retrieve']>
        >;
        const retrievePolicy =
          this.config.memory.retrievePolicy ?? 'once-per-run';
        contextSources.push({
          name: 'agent.memory',
          load: async (runContext) => {
            if (retrievePolicy === 'once-per-turn') {
              return this.config.memory?.retrieve(runContext) ?? [];
            }
            if (!retrieved) {
              cached = await (this.config.memory?.retrieve(runContext) ?? []);
              retrieved = true;
            }
            return cached;
          },
        });
      }
      const planner =
        this.config.planner ??
        new DefaultModelCallPlanner({
          ...(this.config.instructions !== undefined
            ? { instructions: this.config.instructions }
            : {}),
          contextSources,
          reducers: [
            ...(this.config.reducers ?? []),
            ...this.extensions.flatMap((extension) =>
              extension.reducer === undefined ? [] : [extension.reducer],
            ),
          ],
          tools,
          ...(this.config.observers !== undefined
            ? { observers: this.config.observers }
            : {}),
        });

      const maxTurns = Math.max(1, options.maxTurns ?? 8);
      const turns: AgentTurnDiagnostics[] = [];
      let usage = createEmptyUsage();
      let finalResponse: AgentModelResponse | undefined;
      let stopReason: LoopStopReason = 'no-progress';
      const executedResume = await this.prepareResume(
        options.resume,
        toolScheduler,
        stream,
        ctx,
      );

      for (let turnIndex = 0; ; turnIndex += 1) {
        const turn = await this.executeTurn({
          turnIndex,
          runId,
          runControl,
          planner,
          tools,
          toolScheduler,
          options,
          signal,
          stream,
          ctx,
          resume: turnIndex === 0 ? executedResume : undefined,
        });
        turns.push(turn.diagnostics);
        toolCalls.push(...turn.toolCalls);
        if (turn.response !== undefined) {
          finalResponse = turn.response;
          usage = addUsage(usage, turn.response.usage);
        }

        const decision =
          turn.stopReason === undefined
            ? this.decideNextTurn({
                turnIndex,
                maxTurns,
                runControl,
                newMessageCount: turn.newMessages.length,
                hasAssistantFinalAnswer: hasAssistantFinalAnswer(
                  turn.newMessages,
                ),
                signal,
                ...(turn.response !== undefined
                  ? { response: turn.response }
                  : {}),
              })
            : { type: 'stop' as const, reason: turn.stopReason };
        if (decision.type === 'stop') {
          stopReason = decision.reason;
          break;
        }
      }

      const compactions = await this.compactSession(options.sessionId, ctx);
      usage = {
        ...usage,
        toolCalls: usage.toolCalls + toolCalls.length,
      };
      const lastContext = turns.at(-1)?.context;
      const diagnostics: AgentRunDiagnostics = {
        turns,
        queueDrains: [...state.queueDiagnostics],
        pendingCount: runControl.deferredQueue.size,
        ...(lastContext !== undefined ? { context: lastContext } : {}),
        ...(options.resume !== undefined
          ? { resumeSource: 'options.resume' }
          : {}),
        ...(compactions.length > 0 ? { compactions } : {}),
      };
      const result: AgentRunResult = {
        id: runId,
        text: finalResponse?.text ?? '',
        output: finalResponse?.text ?? '',
        messages: [...state.messages],
        usage,
        finishReason: this.finishReasonForStop(stopReason, finalResponse),
        toolCalls,
        pending: runControl.deferredQueue.snapshot(),
        diagnostics,
        metadata: {
          ...metadata,
          ...(finalResponse !== undefined
            ? { provider: finalResponse.provider }
            : {}),
          diagnostics,
        },
      };
      for (const extension of this.extensions) {
        await extension.afterRun?.(result, ctx);
      }
      const messagesToAppend = result.messages.slice(sessionMessages.length);
      await this.saveSessionResult(result, messagesToAppend);
      await this.config.memory?.observe?.(
        { type: 'run.completed', result, diagnostics },
        ctx,
      );
      if (stopReason === 'interrupted') {
        await this.emit(
          { type: 'run.interrupted', runId, messages: [...state.messages] },
          stream,
          ctx,
        );
      }
      await this.emit({ type: 'run.completed', result }, stream, ctx);
      stream.complete(result);
    } catch (error) {
      const normalized = normalizeAgentError(error);
      await this.config.memory?.observe?.(
        {
          type: 'run.failed',
          error: normalized,
          diagnostics: {
            queueDrains: state.queueDiagnostics,
            pendingCount: 0,
          },
        },
        ctx,
      );
      await this.emit(
        { type: 'run.failed', error: normalized, partialMessages: [] },
        stream,
        ctx,
      );
      stream.fail(error);
    }
  }

  private async executeTurn(args: {
    readonly turnIndex: number;
    readonly runId: string;
    readonly runControl: AgentRunControl;
    readonly planner: {
      plan(ctx: AgentRunContext): PromiseLike<ModelCallPlan> | ModelCallPlan;
    };
    readonly tools: AgentModelRequest['tools'];
    readonly toolScheduler: ToolScheduler;
    readonly options: AgentRunOptions;
    readonly signal: AbortSignal;
    readonly stream: AgentEventStream;
    readonly ctx: AgentRunContext;
    readonly resume?: AgentRunOptions['resume'];
  }): Promise<ExecuteTurnResult> {
    (args.ctx.state as { turn: number }).turn = args.turnIndex;
    await this.emit(
      { type: 'turn.started', runId: args.runId, turnIndex: args.turnIndex },
      args.stream,
      args.ctx,
    );

    if (args.signal.aborted) {
      args.runControl.pushDeferred({
        kind: 'interrupted',
        messages: [...args.ctx.state.messages],
        reason: String(args.signal.reason ?? 'Agent stream aborted.'),
      });
      await this.emit(
        { type: 'turn.completed', turnIndex: args.turnIndex },
        args.stream,
        args.ctx,
      );
      return this.emptyTurn(args.turnIndex, args.ctx, 'interrupted');
    }

    const drained = args.runControl.drainNextTurn(args.resume);
    args.ctx.state.queueDiagnostics.push(...drained.diagnostics);
    args.ctx.state.messages.push(...drained.messages);
    for (const diagnostic of drained.diagnostics) {
      await this.emit(
        {
          type: 'queue.drained',
          runId: args.runId,
          queue: diagnostic.queue,
          count: diagnostic.count,
        },
        args.stream,
        args.ctx,
      );
    }

    const plan = await args.planner.plan(args.ctx);
    const transformedMessages = await this.transformModelMessages(
      [...plan.messages],
      args.ctx,
    );
    const callPlan: ModelCallPlan = {
      ...plan,
      messages: transformedMessages,
    };
    const beforeCallMessages = [...args.ctx.state.messages];
    const messageId = randomUUID();
    await this.emit(
      { type: 'message.started', messageId, role: 'assistant' },
      args.stream,
      args.ctx,
    );

    let finalResponse: AgentModelResponse | null = null;
    const modelRequest = this.createModelRequest(
      args.runId,
      callPlan,
      args.tools,
      args.options,
      args.signal,
    );
    try {
      for await (const event of this.modelAdapter.stream(modelRequest)) {
        if (event.type === 'text-delta') {
          await this.emit(
            { type: 'message.delta', messageId, text: event.text },
            args.stream,
            args.ctx,
          );
        } else {
          finalResponse = event.response;
        }
      }
      if (finalResponse === null) {
        finalResponse = await this.modelAdapter.generate(modelRequest);
      }
    } catch (error) {
      if (args.signal.aborted || isAbortError(error)) {
        args.runControl.pushDeferred({
          kind: 'interrupted',
          messages: [...args.ctx.state.messages],
          reason: String(args.signal.reason ?? 'Agent stream aborted.'),
        });
        await this.emit(
          { type: 'turn.completed', turnIndex: args.turnIndex },
          args.stream,
          args.ctx,
        );
        return this.emptyTurn(
          args.turnIndex,
          args.ctx,
          'interrupted',
          plan.diagnostics,
          drained.diagnostics,
        );
      }
      throw error;
    }

    const newMessages =
      finalResponse.newMessages ??
      diffNewMessages(beforeCallMessages, finalResponse.messages);
    const toolCallsFromModel = finalResponse.toolCalls ?? [];
    const scheduled =
      toolCallsFromModel.length === 0
        ? { messages: [] as AgentMessage[], toolCalls: [] as AgentToolCall[], pending: [] }
        : await args.toolScheduler.schedule(toolCallsFromModel, {
            onToolStarted: (toolCallId, name, input) =>
              this.emit(
                { type: 'tool.started', toolCallId, name, input },
                args.stream,
                args.ctx,
              ),
            onApprovalRequired: async (item) => {
              const wasAlreadyPending = hasDeferredApproval(
                args.runControl,
                item.toolCallId,
              );
              if (!wasAlreadyPending) {
                args.runControl.pushDeferred(item);
                await this.emit(
                  { type: 'approval.required', runId: args.runId, item },
                  args.stream,
                  args.ctx,
                );
              }
            },
            onToolCompleted: (toolCallId, output) =>
              this.emit(
                { type: 'tool.completed', toolCallId, output },
                args.stream,
                args.ctx,
              ),
            onToolFailed: (toolCallId, error) =>
              this.emit(
                {
                  type: 'tool.failed',
                  toolCallId,
                  error: normalizeAgentError(error),
                },
                args.stream,
                args.ctx,
              ),
          });
    const allNewMessages = [...newMessages, ...scheduled.messages];
    args.ctx.state.messages.push(...allNewMessages);
    await this.emit(
      { type: 'turn.completed', turnIndex: args.turnIndex },
      args.stream,
      args.ctx,
    );
    if (scheduled.pending.length > 0) {
      return this.emptyTurn(
        args.turnIndex,
        args.ctx,
        'waiting-approval',
        plan.diagnostics,
        drained.diagnostics,
      );
    }

    return {
      response: finalResponse,
      diagnostics: {
        turn: args.turnIndex,
        context: plan.diagnostics,
        queueDrains: drained.diagnostics,
        finishReason: finalResponse.finishReason,
        newMessageCount: allNewMessages.length,
      },
      newMessages: allNewMessages,
      toolCalls: scheduled.toolCalls,
    };
  }

  private async transformModelMessages(
    messages: AgentMessage[],
    ctx: AgentRunContext,
  ): Promise<AgentMessage[]> {
    let transformed = [...messages];
    for (const extension of this.extensions) {
      transformed =
        (await extension.transformMessages?.(transformed, ctx)) ?? transformed;
    }
    return transformed;
  }

  private async prepareResume(
    resume: AgentRunOptions['resume'],
    toolScheduler: ToolScheduler,
    stream: AgentEventStream,
    ctx: AgentRunContext,
  ): Promise<AgentRunOptions['resume']> {
    if (resume === undefined || resume.deferred === undefined) {
      return resume;
    }
    const toolResults: Record<string, unknown> = {
      ...(resume.toolResults ?? {}),
    };
    for (const item of resume.deferred) {
      if (item.kind !== 'approval') {
        continue;
      }
      const decision = resume.approvals?.[item.toolCallId];
      const approved =
        typeof decision === 'boolean' ? decision : (decision?.approved ?? false);
      if (!approved || toolResults[item.toolCallId] !== undefined) {
        continue;
      }
      const result = await toolScheduler.executeApproved(
        {
          id: item.toolCallId,
          name: item.toolName,
          input: item.input,
        },
        {
          onToolStarted: (toolCallId, name, input) =>
            this.emit(
              { type: 'tool.started', toolCallId, name, input },
              stream,
              ctx,
            ),
          onApprovalRequired: async () => {},
          onToolCompleted: (toolCallId, output) =>
            this.emit({ type: 'tool.completed', toolCallId, output }, stream, ctx),
          onToolFailed: (toolCallId, error) =>
            this.emit(
              {
                type: 'tool.failed',
                toolCallId,
                error: normalizeAgentError(error),
              },
              stream,
              ctx,
            ),
        },
      );
      toolResults[item.toolCallId] =
        result.error !== undefined ? { error: result.error.message } : result.output;
    }
    return {
      ...resume,
      toolResults,
    } satisfies DeferredRunResults;
  }

  private emptyTurn(
    turnIndex: number,
    ctx: AgentRunContext,
    stopReason: LoopStopReason,
    context = emptyContextDiagnostics(),
    queueDrains: QueueDrainDiagnostic[] = [],
  ): ExecuteTurnResult {
    return {
      diagnostics: {
        turn: turnIndex,
        context,
        queueDrains,
        finishReason: this.finishReasonForStop(stopReason),
        newMessageCount: 0,
      },
      newMessages: [],
      toolCalls: [],
      stopReason,
    };
  }

  private decideNextTurn(input: {
    readonly turnIndex: number;
    readonly maxTurns: number;
    readonly runControl: AgentRunControl;
    readonly response?: AgentModelResponse;
    readonly newMessageCount: number;
    readonly hasAssistantFinalAnswer: boolean;
    readonly signal: AbortSignal;
  }): LoopDecision {
    if (input.signal.aborted) {
      return { type: 'stop', reason: 'interrupted' };
    }
    if (input.runControl.status === 'waiting_approval') {
      return { type: 'stop', reason: 'waiting-approval' };
    }
    if (input.turnIndex + 1 >= input.maxTurns) {
      return { type: 'stop', reason: 'max-turns' };
    }
    if (input.runControl.hasQueuedWork()) {
      return { type: 'continue', reason: 'queued-work' };
    }
    if (input.response?.finishReason === 'tool-calls') {
      if (input.newMessageCount > 0) {
        return { type: 'continue', reason: 'tool-calls' };
      }
      return { type: 'stop', reason: 'no-progress' };
    }
    if (
      input.response?.finishReason === 'stop' &&
      input.hasAssistantFinalAnswer
    ) {
      return { type: 'stop', reason: 'natural-completed' };
    }
    if (input.newMessageCount === 0) {
      return { type: 'stop', reason: 'no-progress' };
    }
    return { type: 'continue', reason: 'progress' };
  }

  private finishReasonForStop(
    stopReason: LoopStopReason,
    response?: AgentModelResponse,
  ): AgentRunResult['finishReason'] {
    if (stopReason === 'natural-completed') {
      return 'stop';
    }
    if (stopReason === 'max-turns') {
      return 'length';
    }
    if (stopReason === 'waiting-approval') {
      return 'approval-required';
    }
    if (stopReason === 'interrupted') {
      return 'interrupted';
    }
    if (stopReason === 'no-progress') {
      return 'no-progress';
    }
    return response?.finishReason ?? 'error';
  }

  /**
   * 懒初始化 extension。
   *
   * Returns:
   *   首次调用会执行 setup hooks；后续调用直接返回。
   */
  private async setup(): Promise<void> {
    if (this.setupDone) {
      return;
    }
    this.setupDone = true;
    for (const extension of this.extensions) {
      await extension.setup?.({ agentId: randomUUID() });
    }
  }

  private async emit(
    event: AgentStreamEvent,
    stream: AgentEventStream,
    ctx: AgentRunContext,
  ): Promise<void> {
    ctx.trace.events.push(event);
    stream.emit(event);
    await this.emitObserverEvent(event, ctx);
    if (ctx.sessionId !== undefined) {
      await this.config.session?.appendEvent?.(ctx.sessionId, event);
    }
    for (const extension of this.extensions) {
      await extension.onEvent?.(event, ctx);
    }
  }

  private async emitObserverEvent(
    event: AgentStreamEvent,
    ctx: AgentRunContext,
  ): Promise<void> {
    for (const observer of this.config.observers ?? []) {
      if (event.type === 'run.started') {
        await observer.onRunStarted?.({ runId: event.runId }, ctx);
      } else if (event.type === 'turn.started') {
        await observer.onTurnStarted?.(
          { runId: event.runId, turnIndex: event.turnIndex },
          ctx,
        );
      } else if (event.type === 'tool.started') {
        this.observerToolCalls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.name,
          input: event.input,
        });
        await observer.onToolScheduled?.(
          { id: event.toolCallId, name: event.name, input: event.input },
          ctx,
        );
      } else if (event.type === 'approval.required') {
        await observer.onToolApprovalRequired?.(event.item, ctx);
      } else if (event.type === 'tool.completed') {
        const started = this.observerToolCalls.get(event.toolCallId);
        const completed = {
          id: event.toolCallId,
          name: started?.name ?? event.toolCallId,
          input: started?.input ?? null,
          output: event.output,
        };
        this.observerToolCalls.set(event.toolCallId, completed);
        await observer.onToolCompleted?.(
          completed,
          ctx,
        );
      } else if (event.type === 'run.completed') {
        await observer.onRunCompleted?.(event.result, ctx);
      } else if (event.type === 'run.failed') {
        await observer.onRunFailed?.({ error: event.error }, ctx);
      }
    }
  }

  /**
   * 从所有 session 扩展读取历史消息。
   *
   * Returns:
   *   按扩展顺序拼接后的消息历史。
   */
  private async loadSessionMessages(
    sessionId?: string,
  ): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];
    if (this.config.session !== undefined && sessionId !== undefined) {
      messages.push(...(await this.config.session.load(sessionId)));
    }
    for (const extension of this.extensions) {
      const session = extension as AgentSessionExtension;
      messages.push(...((await session.loadMessages?.()) ?? []));
    }
    return messages;
  }

  private async saveSessionResult(
    result: AgentRunResult,
    messagesToAppend: AgentMessage[],
  ): Promise<void> {
    const sessionId =
      typeof result.metadata.sessionId === 'string'
        ? result.metadata.sessionId
        : undefined;
    if (this.config.session !== undefined && sessionId !== undefined) {
      await this.config.session.append(
        sessionId,
        messagesToAppend,
        result.metadata,
      );
    }
    for (const extension of this.extensions) {
      const session = extension as AgentSessionExtension;
      await session.saveResult?.(result);
    }
  }

  private async compactSession(
    sessionId: string | undefined,
    ctx: AgentRunContext,
  ) {
    if (
      sessionId === undefined ||
      this.config.session === undefined ||
      this.config.compactor === undefined
    ) {
      return [];
    }
    const report = await this.config.compactor.maybeCompact(
      sessionId,
      this.config.session,
      ctx,
    );
    return report === null ? [] : [report];
  }

  private createModelRequest(
    runId: string,
    plan: {
      system?: string;
      messages: AgentMessage[];
      tools?: AgentModelRequest['tools'];
      activeTools?: string[];
      toolChoice?: AgentModelRequest['toolChoice'];
      providerOptions?: Record<string, unknown>;
    },
    fallbackTools: AgentModelRequest['tools'],
    options: AgentRunOptions,
    signal: AbortSignal,
  ): AgentModelRequest {
    return {
      runId,
      model: this.config.model,
      ...(plan.system !== undefined ? { system: plan.system } : {}),
      messages: plan.messages,
      tools: plan.tools ?? fallbackTools,
      ...(plan.activeTools !== undefined
        ? { activeTools: plan.activeTools }
        : {}),
      ...(plan.toolChoice !== undefined ? { toolChoice: plan.toolChoice } : {}),
      ...(plan.providerOptions !== undefined
        ? { providerOptions: plan.providerOptions }
        : {}),
      modelSettings: {
        ...(this.config.modelSettings ?? {}),
        ...(options.modelSettings ?? {}),
      },
      signal,
    };
  }
}

function hasAssistantFinalAnswer(messages: readonly AgentMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'assistant') {
      return false;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      return content.length > 0;
    }
    return Array.isArray(content) && content.length > 0;
  });
}

function hasDeferredApproval(
  runControl: AgentRunControl,
  toolCallId: string,
): boolean {
  return runControl.deferredQueue
    .snapshot()
    .some((item) => item.kind === 'approval' && item.toolCallId === toolCallId);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function emptyContextDiagnostics(): ContextDiagnostics {
  return {
    bundles: [],
    reducerReports: [],
    summaryCount: 0,
    beforeMessageCount: 0,
    afterMessageCount: 0,
  };
}
