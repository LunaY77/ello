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
  AgentRunContext,
  AgentRunDiagnostics,
  AgentRunState,
  AgentRunOptions,
  AgentRunResult,
  AgentSessionExtension,
  AgentStream,
  AgentToolCall,
  CreateAgentOptions,
  ModelAdapter,
  AgentModelRequest,
  AgentTrace,
} from '../public/types.js';

import { normalizeInput } from './messages.js';
import {
  createEnvironmentContextSource,
  createStateContextSource,
  DefaultModelCallPlanner,
} from './planner.js';
import { AgentRunControl } from './run-control.js';
import { AgentEventStream } from './stream.js';
import { buildToolSet } from './tool-runner.js';
import { AgentApprovalRequiredError } from './tool-runner.js';

/**
 * 新框架 Agent 实现。
 *
 * CoreAgent 负责把 public API 组合成完整运行流程：
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
export class CoreAgent implements Agent {
  private readonly environment: AgentEnvironment;
  private readonly extensions: readonly AgentExtension[];
  private readonly modelAdapter: ModelAdapter;
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
    const stream = new AgentEventStream(abortController);
    void this.execute(input, options, abortController.signal, stream);
    return stream;
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
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      input,
      context: options.context ?? (typeof input === 'object' && !Array.isArray(input) ? input.context : undefined),
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
      await this.emit({ type: 'turn.started', runId, turnIndex: 0 }, stream, ctx);
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

      const drained = runControl.drainNextTurn(options.resume);
      state.queueDiagnostics.push(...drained.diagnostics);
      state.messages.push(...drained.messages);

      let messages = [...state.messages];
      for (const extension of this.extensions) {
        messages = (await extension.transformMessages?.(messages, ctx)) ?? messages;
      }
      state.messages.splice(0, state.messages.length, ...messages);

      const toolCalls: AgentToolCall[] = [];
      const tools = buildToolSet({
        runId,
        tools: this.config.tools ?? [],
        environment: this.environment,
        metadata,
        toolCalls,
        emitToolStarted: (toolCallId, name, toolInput) => {
          void this.emit(
            { type: 'tool.started', toolCallId, name, input: toolInput },
            stream,
            ctx,
          );
        },
        emitApprovalRequired: (toolCallId, name, toolInput) => {
          runControl.pushDeferred({
            kind: 'approval',
            toolCallId,
            toolName: name,
            input: toolInput,
          });
          void this.emit(
            {
              type: 'approval.required',
              runId,
              item: {
                kind: 'approval',
                toolCallId,
                toolName: name,
                input: toolInput,
              },
            },
            stream,
            ctx,
          );
        },
        emitToolCompleted: (toolCallId, output) => {
          void this.emit({ type: 'tool.completed', toolCallId, output }, stream, ctx);
        },
        emitToolFailed: (toolCallId, error) => {
          void this.emit(
            { type: 'tool.failed', toolCallId, error: normalizeAgentError(error) },
            stream,
            ctx,
          );
        },
      });
      const contextSources = [
        createStateContextSource(),
        createEnvironmentContextSource(),
        ...(this.config.context ?? []),
      ];
      if (this.config.memory !== undefined) {
        contextSources.push({
          name: 'agent.memory',
          load: (runContext) => this.config.memory?.retrieve(runContext) ?? [],
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
      const plan = await planner.plan(ctx);

      const messageId = randomUUID();
      await this.emit({ type: 'message.started', messageId, role: 'assistant' }, stream, ctx);
      let finalResponse = null as Awaited<ReturnType<ModelAdapter['generate']>> | null;
      const modelRequest = this.createModelRequest(runId, plan, tools, options, signal);
      for await (const event of this.modelAdapter.stream(modelRequest)) {
        if (event.type === 'text-delta') {
          await this.emit({ type: 'message.delta', messageId, text: event.text }, stream, ctx);
        } else {
          finalResponse = event.response;
        }
      }
      if (finalResponse === null) {
        finalResponse = await this.modelAdapter.generate(modelRequest);
      }

      const compactions = await this.compactSession(options.sessionId, ctx);
      const diagnostics: AgentRunDiagnostics = {
        context: plan.diagnostics,
        queueDrains: [...state.queueDiagnostics],
        pendingCount: runControl.deferredQueue.size,
        ...(options.resume !== undefined ? { resumeSource: 'options.resume' } : {}),
        ...(compactions.length > 0 ? { compactions } : {}),
      };
      const result: AgentRunResult = {
        id: runId,
        text: finalResponse.text,
        output: finalResponse.text,
        messages: finalResponse.messages as AgentMessage[],
        usage: {
          ...finalResponse.usage,
          toolCalls: finalResponse.usage.toolCalls + toolCalls.length,
        },
        finishReason: finalResponse.finishReason,
        toolCalls,
        pending: runControl.deferredQueue.snapshot(),
        diagnostics,
        metadata: {
          ...metadata,
          provider: finalResponse.provider,
          diagnostics,
        },
      };
      await this.emit({ type: 'turn.completed', turnIndex: 0 }, stream, ctx);
      for (const extension of this.extensions) {
        await extension.afterRun?.(result, ctx);
      }
      await this.saveSessionResult(result);
      await this.config.memory?.observe?.(
        { type: 'run.completed', result, diagnostics },
        ctx,
      );
      await this.emit({ type: 'run.completed', result }, stream, ctx);
      stream.complete(result);
    } catch (error) {
      const normalized = normalizeAgentError(error);
      if (error instanceof AgentApprovalRequiredError) {
        const diagnostics: AgentRunDiagnostics = {
          queueDrains: state.queueDiagnostics,
          pendingCount: 1,
        };
        const result: AgentRunResult = {
          id: runId,
          text: '',
          output: '',
          messages: [...state.messages],
          usage: {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            toolCalls: 0,
          },
          finishReason: 'tool-calls',
          toolCalls: [],
          pending: [
            {
              kind: 'approval',
              toolCallId: error.toolCallId,
              toolName: error.toolName,
              input: error.input,
            },
          ],
          diagnostics,
          metadata: { ...metadata, diagnostics },
        };
        await this.emit({ type: 'run.completed', result }, stream, ctx);
        stream.complete(result);
        return;
      }
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
    for (const extension of this.extensions) {
      await extension.onEvent?.(event, ctx);
    }
  }

  /**
   * 从所有 session 扩展读取历史消息。
   *
   * Returns:
   *   按扩展顺序拼接后的消息历史。
   */
  private async loadSessionMessages(sessionId?: string): Promise<AgentMessage[]> {
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

  private async saveSessionResult(result: AgentRunResult): Promise<void> {
    const sessionId =
      typeof result.metadata.sessionId === 'string' ? result.metadata.sessionId : undefined;
    if (this.config.session !== undefined && sessionId !== undefined) {
      await this.config.session.append(sessionId, result.messages, result.metadata);
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
    plan: { system?: string; messages: AgentMessage[]; tools?: AgentModelRequest['tools']; activeTools?: string[]; toolChoice?: AgentModelRequest['toolChoice']; providerOptions?: Record<string, unknown> },
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
      ...(plan.activeTools !== undefined ? { activeTools: plan.activeTools } : {}),
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
