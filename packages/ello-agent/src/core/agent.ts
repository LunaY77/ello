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
  AgentRunOptions,
  AgentRunResult,
  AgentSessionExtension,
  AgentStream,
  AgentToolCall,
  CreateAgentOptions,
  ModelAdapter,
} from '../public/types.js';

import { normalizeInput } from './messages.js';
import { AgentEventStream } from './stream.js';
import { buildToolSet } from './tool-runner.js';

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
    const ctx: AgentRunContext = {
      runId,
      input,
      options,
      environment: this.environment,
      metadata,
    };

    try {
      await this.setup();
      await this.emit({ type: 'run.started', runId }, stream, ctx);
      await this.emit({ type: 'turn.started', runId, turnIndex: 0 }, stream, ctx);
      for (const extension of this.extensions) {
        await extension.beforeRun?.(ctx);
      }

      let messages = [
        ...(await this.loadSessionMessages()),
        ...normalizeInput(input),
        ...(options.messages ?? []),
      ];
      if (this.config.instructions !== undefined) {
        messages.unshift({ role: 'system', content: this.config.instructions });
      }
      const environmentInstructions = await this.environment.getInstructions?.();
      if (environmentInstructions) {
        messages.unshift({ role: 'system', content: environmentInstructions });
      }
      for (const extension of this.extensions) {
        messages = (await extension.transformMessages?.(messages, ctx)) ?? messages;
      }

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

      const messageId = randomUUID();
      await this.emit({ type: 'message.started', messageId, role: 'assistant' }, stream, ctx);
      let finalResponse = null as Awaited<ReturnType<ModelAdapter['generate']>> | null;
      for await (const event of this.modelAdapter.stream({
        runId,
        model: this.config.model,
        messages,
        tools,
        modelSettings: {
          ...(this.config.modelSettings ?? {}),
          ...(options.modelSettings ?? {}),
        },
        signal,
      })) {
        if (event.type === 'text-delta') {
          await this.emit({ type: 'message.delta', messageId, text: event.text }, stream, ctx);
        } else {
          finalResponse = event.response;
        }
      }
      if (finalResponse === null) {
        finalResponse = await this.modelAdapter.generate({
          runId,
          model: this.config.model,
          messages,
          tools,
          modelSettings: {
            ...(this.config.modelSettings ?? {}),
            ...(options.modelSettings ?? {}),
          },
          signal,
        });
      }

      const result: AgentRunResult = {
        id: runId,
        output: finalResponse.text,
        messages: finalResponse.messages as AgentMessage[],
        usage: {
          ...finalResponse.usage,
          toolCalls: finalResponse.usage.toolCalls + toolCalls.length,
        },
        finishReason: finalResponse.finishReason,
        toolCalls,
        metadata: {
          ...metadata,
          provider: finalResponse.provider,
        },
      };
      await this.emit({ type: 'turn.completed', turnIndex: 0 }, stream, ctx);
      for (const extension of this.extensions) {
        await extension.afterRun?.(result, ctx);
      }
      await this.saveSessionResult(result);
      await this.emit({ type: 'run.completed', result }, stream, ctx);
      stream.complete(result);
    } catch (error) {
      const normalized = normalizeAgentError(error);
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
  private async loadSessionMessages(): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];
    for (const extension of this.extensions) {
      const session = extension as AgentSessionExtension;
      messages.push(...((await session.loadMessages?.()) ?? []));
    }
    return messages;
  }

  private async saveSessionResult(result: AgentRunResult): Promise<void> {
    for (const extension of this.extensions) {
      const session = extension as AgentSessionExtension;
      await session.saveResult?.(result);
    }
  }
}
