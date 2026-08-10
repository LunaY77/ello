/**
 * 本文件负责 agent feature 的运行编排与结果投影。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { SessionMode } from '../../protocol/v1/index.js';

import type {
  AgentResumeResult,
  AgentRun,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  BuiltAgent,
} from './contracts.js';
import type {
  AgentRunResult as EngineRunResult,
  AgentMessage,
  AgentStream,
  DeferredApprovalItem,
  DeferredRunItem,
  DeferredToolCallItem,
  EngineEvent,
} from './engine/index.js';

interface RunningAgentOptions {
  readonly agent: BuiltAgent['engine'];
  /**
   * 按 产品 Agent 运行 模块 的一致性约束执行 `setMode` 状态变更。
   *
   * Args:
   * - `mode`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   *
   * Returns:
   * - 产品 Agent 运行 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  setMode(mode: SessionMode): void;
  /**
   * 执行 产品 Agent 运行 模块 定义的 `closeAgent` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 产品 Agent 运行 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 产品 Agent 运行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  closeAgent(): Promise<void>;
  readonly threadId: string;
  readonly turnId: string;
  readonly history: ReadonlyArray<AgentMessage>;
  readonly input: string;
  readonly maxTurns: number | undefined;
  /**
   * 主模型自然停止后等待后台任务的持久通知。
   *
   * Args:
   * - `signal`: 当前等待阶段的取消信号；用户输入或 run 中断都会取消等待。
   *
   * Returns:
   * - 有通知时返回下一轮模型输入，没有活动后台任务时返回 `undefined`。
   */
  readonly waitForTaskNotification?: (
    signal: AbortSignal,
  ) => Promise<string | undefined>;
}

interface QueuedRunInput {
  readonly kind: 'steer' | 'notification';
  readonly id: string;
  readonly text: string;
}

/**
 * 启动一次独立 Agent run；所有可变执行状态都只存在于对应运行对象中。
 *
 * Args:
 * - `built`: `startAgentRun` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `request`: 进入 产品 Agent 运行 模块 的稳定请求；校验后只读传递，不由函数修改。
 *
 * Returns:
 * - 返回 `startAgentRun` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent 运行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function startAgentRun(
  built: BuiltAgent,
  request: AgentRunRequest,
): AgentRun {
  return new RunningAgent({
    agent: built.engine,
    setMode: built.setMode,
    closeAgent: built.close,
    threadId: request.threadId,
    turnId: request.turnId,
    history: request.history,
    input: request.input,
    maxTurns: built.maxTurns,
    ...(built.waitForTaskNotification === undefined
      ? {}
      : { waitForTaskNotification: built.waitForTaskNotification }),
  });
}

class RunningAgent implements AgentRun {
  readonly events: AsyncIterable<AgentRunEvent>;
  readonly result: Promise<AgentRunResult>;

  private readonly queue = new AsyncQueue<AgentRunEvent>();
  private readonly interactions;
  private readonly messageText = new Map<string, string>();
  private readonly reasoningText = new Map<string, string>();
  private readonly pendingInputs: QueuedRunInput[] = [];
  private readonly waitingInputs: QueuedRunInput[] = [];
  private readonly pendingCompactionAcknowledgements = new Map<
    string,
    {
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  private readonly abortController = new AbortController();
  private activeStream: AgentStream | undefined;
  private phase: 'transitioning' | 'streaming' | 'waiting' | 'closed' =
    'transitioning';
  private wakeWaitingInput: (() => void) | undefined;
  private interruptReason: string | undefined;

  constructor(private readonly options: RunningAgentOptions) {
    this.interactions = createRunInteractions({
      publish: (event) => this.queue.push(event),
      setMode: options.setMode,
    });
    this.events = this.queue;
    this.result = this.runAgent();
  }

  steer(steerId: string, input: string): void {
    this.enqueueInput({ kind: 'steer', id: steerId, text: input });
  }

  notify(notificationId: string, input: string): void {
    this.enqueueInput({
      kind: 'notification',
      id: notificationId,
      text: input,
    });
  }

  interrupt(reason: string): void {
    this.interruptReason = reason;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason);
    }
    this.activeStream?.abort(reason);
    this.wakeWaitingInput?.();
    this.interactions.interrupt(reason);
  }

  resume(result: AgentResumeResult): void {
    this.interactions.resume(result);
  }

  acknowledgeCompaction(compactionId: string, error?: unknown): void {
    const acknowledgement =
      this.pendingCompactionAcknowledgements.get(compactionId);
    if (acknowledgement === undefined) {
      throw new Error(
        `Unknown Context Checkpoint acknowledgement ${compactionId}.`,
      );
    }
    this.pendingCompactionAcknowledgements.delete(compactionId);
    if (error === undefined) acknowledgement.resolve();
    else acknowledgement.reject(error);
  }

  private async runAgent(): Promise<AgentRunResult> {
    let usage = emptyUsage();
    try {
      let messages = [...this.options.history];
      let stream = this.options.agent.stream(
        { messages, prompt: this.options.input },
        this.runOptions(),
      );
      while (true) {
        this.activeStream = stream;
        this.phase = 'streaming';
        for await (const event of stream) await this.publish(event);
        const result = await stream.final;
        this.activeStream = undefined;
        this.phase = 'transitioning';
        usage = addUsage(usage, result.usage);
        this.completeOpenMessages();
        messages = [...result.messages];
        if (
          this.interruptReason !== undefined ||
          result.finishReason === 'interrupted'
        ) {
          this.queue.end();
          return {
            status: 'interrupted',
            usage,
            reason: this.interruptReason ?? 'agent interrupted',
          };
        }
        const pending = result.pending;
        if (pending.length === 0) {
          if (isFailure(result)) {
            this.queue.end();
            return {
              status: 'failed',
              usage,
              error: {
                code: 'AGENT_RUN_FAILED',
                message:
                  result.finishReason === 'length' &&
                  result.output.trim() === ''
                    ? 'Agent reached max turns without a final answer.'
                    : `Agent finished with ${result.finishReason}.`,
              },
            };
          }
          const notification = await this.waitForContinuation();
          if (this.interruptReason !== undefined) {
            this.phase = 'closed';
            this.queue.end();
            return {
              status: 'interrupted',
              usage,
              reason: this.interruptReason,
            };
          }
          if (notification !== undefined) {
            stream = this.options.agent.stream(
              { messages, prompt: notification },
              this.runOptions(),
            );
            this.forwardWaitingInputs(stream);
            continue;
          }
          const input = this.waitingInputs.shift();
          if (input !== undefined) {
            if (input.kind === 'steer') this.publishConsumedInput(input);
            stream = this.options.agent.stream(
              { messages, prompt: input.text },
              this.runOptions(),
            );
            this.forwardWaitingInputs(stream);
            continue;
          }
          this.phase = 'closed';
          this.queue.end();
          return { status: 'completed', usage };
        }
        const resolution = await this.interactions.resolveDeferred(pending);
        stream = this.options.agent.resume(
          {
            messages,
            deferred: {
              deferred: pending,
              approvals: resolution.approvals,
              toolResults: resolution.toolResults,
            },
          },
          this.runOptions(),
        );
      }
    } catch (error) {
      this.phase = 'closed';
      this.queue.fail(error);
      if (this.interruptReason !== undefined) {
        return {
          status: 'interrupted',
          usage,
          reason: this.interruptReason,
        };
      }
      return {
        status: 'failed',
        usage,
        error: {
          code: 'AGENT_EXECUTION_FAILED',
          message: errorMessage(error),
        },
      };
    } finally {
      this.phase = 'closed';
      this.activeStream = undefined;
      this.wakeWaitingInput?.();
      await this.options.closeAgent();
    }
  }

  private enqueueInput(input: QueuedRunInput): void {
    const stream = this.activeStream;
    if (stream !== undefined && this.phase === 'streaming') {
      stream.steer({ role: 'user', content: input.text });
      this.pendingInputs.push(input);
      return;
    }
    if (this.phase !== 'waiting') {
      throw new Error('Agent run is not accepting input.');
    }
    this.waitingInputs.push(input);
    this.wakeWaitingInput?.();
  }

  private async waitForContinuation(): Promise<string | undefined> {
    const waitForTaskNotification = this.options.waitForTaskNotification;
    if (waitForTaskNotification === undefined) return undefined;
    this.phase = 'waiting';
    const waitController = new AbortController();
    const abortWait = () =>
      waitController.abort(this.abortController.signal.reason);
    this.abortController.signal.addEventListener('abort', abortWait, {
      once: true,
    });
    try {
      return await Promise.race([
        waitForTaskNotification(waitController.signal),
        this.waitForWaitingInput().then(() => undefined),
      ]);
    } finally {
      this.phase = 'transitioning';
      this.wakeWaitingInput = undefined;
      this.abortController.signal.removeEventListener('abort', abortWait);
      if (!waitController.signal.aborted) waitController.abort();
    }
  }

  private waitForWaitingInput(): Promise<void> {
    if (this.waitingInputs.length > 0 || this.abortController.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.wakeWaitingInput = resolve;
    });
  }

  private forwardWaitingInputs(stream: AgentStream): void {
    for (const input of this.waitingInputs.splice(0)) {
      stream.steer({ role: 'user', content: input.text });
      this.pendingInputs.push(input);
    }
  }

  private publishConsumedInput(input: QueuedRunInput): void {
    this.queue.push({
      type: 'steeringConsumed',
      steerId: input.id,
      text: input.text,
      occurredAt: new Date().toISOString(),
    });
  }

  private runOptions() {
    return {
      ...(this.options.maxTurns === undefined
        ? {}
        : { maxTurns: this.options.maxTurns }),
      metadata: {
        threadId: this.options.threadId,
        turnId: this.options.turnId,
      },
      waitForContextCompactionCommit: (compactionId: string) =>
        this.waitForCompactionCommit(compactionId),
    } as const;
  }

  private async publish(rawEvent: EngineEvent): Promise<void> {
    const event = rawEvent;
    switch (event.type) {
      case 'reasoning.started':
        if (this.reasoningText.has(event.reasoningId)) {
          throw new Error(
            `Reasoning ${event.reasoningId} started more than once.`,
          );
        }
        this.reasoningText.set(event.reasoningId, '');
        this.queue.push({
          type: 'reasoningStarted',
          reasoningId: event.reasoningId,
          occurredAt: event.occurredAt,
        });
        return;
      case 'reasoning.delta':
        this.reasoningText.set(
          event.reasoningId,
          `${this.requireReasoningText(event.reasoningId)}${event.text}`,
        );
        this.queue.push({
          type: 'reasoningDelta',
          reasoningId: event.reasoningId,
          text: event.text,
        });
        return;
      case 'reasoning.completed':
        this.requireReasoningText(event.reasoningId);
        this.reasoningText.delete(event.reasoningId);
        this.queue.push({
          type: 'reasoningCompleted',
          reasoningId: event.reasoningId,
          text: event.text,
        });
        return;
      case 'message.started':
        if (this.messageText.has(event.messageId)) {
          throw new Error(`Message ${event.messageId} started more than once.`);
        }
        this.messageText.set(event.messageId, '');
        this.queue.push({
          type: 'messageStarted',
          messageId: event.messageId,
          occurredAt: event.occurredAt,
        });
        return;
      case 'message.delta':
        this.messageText.set(
          event.messageId,
          `${this.requireMessageText(event.messageId)}${event.text}`,
        );
        this.queue.push({
          type: 'messageDelta',
          messageId: event.messageId,
          text: event.text,
        });
        return;
      case 'tool.started':
      case 'tool.completed':
      case 'tool.failed':
        // Provider outer Tool 事件仅用于 engine observability；产品使用内部 Command 事件。
        return;
      case 'approval.required':
        this.interactions.register(event.item, event.occurredAt);
        return;
      case 'tool.deferred':
        this.interactions.register(event.item, event.occurredAt);
        return;
      case 'command.event':
        this.queue.push({ type: 'commandRunEvent', event: event.event });
        return;
      case 'context.compaction.started':
        this.queue.push({
          type: 'contextCompactionStarted',
          compactionId: event.compactionId,
          beforeMessageCount: event.beforeMessageCount,
          tokensBefore: event.tokensBefore,
          occurredAt: event.occurredAt,
        });
        return;
      case 'context.compaction':
        this.publishCompaction(event);
        return;
      case 'run.failed':
        this.queue.push({
          type: 'runFailed',
          code: event.error.name || 'AGENT_ERROR',
          message: event.error.message,
          occurredAt: event.occurredAt,
        });
        return;
      case 'model.completed':
        this.completeOpenMessages();
        return;
      case 'model.failed':
        // 重试会启动新的 assistant message；先关闭当前部分消息，避免客户端
        // 永久保留 in-progress item。
        this.completeOpenMessages();
        return;
      case 'queue.drained':
        if (event.queue === 'steering') {
          this.publishConsumedInputs(event.count, event.occurredAt);
        }
        return;
      case 'messages.appended':
        this.queue.push({
          type: 'messagesAppended',
          messages: event.messages,
        });
        return;
      case 'run.completed':
      case 'run.started':
      case 'turn.started':
      case 'turn.completed':
      case 'model.started':
      case 'model.first_token':
      case 'tool.approval_requested':
      case 'run.interrupted':
        return;
      default:
        event satisfies never;
        throw new Error(`Unhandled engine event: ${String(event)}`);
    }
  }

  private publishCompaction(
    event: Extract<EngineEvent, { type: 'context.compaction' }>,
  ): void {
    this.queue.push({
      type: 'contextCompacted',
      compactionId: event.compactionId,
      beforeMessageCount: event.beforeMessageCount,
      afterMessageCount: event.afterMessageCount,
      summary: event.summary,
      keptMessageCount: event.keptMessageCount,
      tokensBefore: event.tokensBefore,
      occurredAt: event.occurredAt,
    });
  }

  private waitForCompactionCommit(compactionId: string): Promise<void> {
    if (this.pendingCompactionAcknowledgements.has(compactionId)) {
      throw new Error(
        `Context Checkpoint ${compactionId} is already awaiting acknowledgement.`,
      );
    }
    let resolveAcknowledgement: (() => void) | undefined;
    let rejectAcknowledgement: ((error: unknown) => void) | undefined;
    const acknowledgement = new Promise<void>((resolve, reject) => {
      resolveAcknowledgement = resolve;
      rejectAcknowledgement = reject;
    });
    if (
      resolveAcknowledgement === undefined ||
      rejectAcknowledgement === undefined
    ) {
      throw new Error('Context Checkpoint acknowledgement did not initialize.');
    }
    this.pendingCompactionAcknowledgements.set(compactionId, {
      resolve: resolveAcknowledgement,
      reject: rejectAcknowledgement,
    });
    return acknowledgement;
  }

  private completeOpenMessages(): void {
    for (const [messageId, text] of this.messageText) {
      this.queue.push({ type: 'messageCompleted', messageId, text });
      this.messageText.delete(messageId);
    }
  }

  /**
   * 把 engine 的 steering drain 事实关联回产品层输入，只为用户 steer 发布消费事件。
   *
   * Args:
   * - `count`: engine 本回合实际抽取的 steering 数量。
   * - `occurredAt`: engine 发布 drain 事实的时间。
   *
   * Returns:
   * - 所有对应事件完成入队后同步返回。
   *
   * Throws:
   * - 当 engine 抽取数量超过产品层已登记输入时抛错，避免错误关联。
   */
  private publishConsumedInputs(count: number, occurredAt: string): void {
    if (count > this.pendingInputs.length) {
      throw new Error(
        `Engine drained ${count} steering messages with only ${this.pendingInputs.length} pending.`,
      );
    }
    for (let index = 0; index < count; index += 1) {
      const input = this.pendingInputs.shift();
      if (input === undefined) {
        throw new Error('Pending input correlation was unexpectedly empty.');
      }
      if (input.kind === 'steer') {
        this.queue.push({
          type: 'steeringConsumed',
          steerId: input.id,
          text: input.text,
          occurredAt,
        });
      }
    }
  }

  private requireMessageText(messageId: string): string {
    const text = this.messageText.get(messageId);
    if (text === undefined) {
      throw new Error(
        `Message ${messageId} emitted a delta before it started.`,
      );
    }
    return text;
  }

  private requireReasoningText(reasoningId: string): string {
    const text = this.reasoningText.get(reasoningId);
    if (text === undefined) {
      throw new Error(
        `Reasoning ${reasoningId} emitted an event before it started.`,
      );
    }
    return text;
  }
}

type InteractionResolution =
  | {
      readonly type: 'approval';
      readonly approved: boolean;
      readonly reason?: string;
    }
  | { readonly type: 'toolResult'; readonly result: unknown };

interface PendingInteraction {
  readonly item: DeferredApprovalItem | DeferredToolCallItem;
  readonly result: Promise<InteractionResolution>;
  /**
   * 在 产品 Agent 运行 模块 中执行 `resolve` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `result`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
   *
   * Returns:
   * - 产品 Agent 运行 模块 的同步状态变更完成后返回，不产生业务结果。
   *
   * Throws:
   * - 当 产品 Agent 运行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  resolve(result: InteractionResolution): void;
  /**
   * 执行 产品 Agent 运行 模块 定义的 `reject` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `error`: 上游捕获的失败值；函数保留原始 cause 并转换为当前错误契约。
   *
   * Returns:
   * - 产品 Agent 运行 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  reject(error: Error): void;
}

interface RunInteractionsOptions {
  /**
   * 处理 产品 Agent 运行 模块 的 `publish` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   *
   * Returns:
   * - 产品 Agent 运行 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  publish(event: AgentRunEvent): void;
  /**
   * 按 产品 Agent 运行 模块 的一致性约束执行 `setMode` 状态变更。
   *
   * Args:
   * - `mode`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   *
   * Returns:
   * - 产品 Agent 运行 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  setMode(mode: SessionMode): void;
}

function createRunInteractions(options: RunInteractionsOptions) {
  const pending = new Map<string, PendingInteraction>();

  const register = (
    item: DeferredApprovalItem | DeferredToolCallItem,
    occurredAt: string,
  ): void => {
    if (pending.has(item.toolCallId)) {
      throw new Error(`Duplicate Agent interaction ${item.toolCallId}.`);
    }
    let resolveResult:
      | ((resolution: InteractionResolution) => void)
      | undefined;
    let rejectResult: ((error: Error) => void) | undefined;
    const result = new Promise<InteractionResolution>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    if (resolveResult === undefined || rejectResult === undefined) {
      throw new Error(
        `Interaction ${item.toolCallId} did not initialize its deferred controls.`,
      );
    }
    // `pending` 持有原始 Promise；observer 仅避免调用方尚未 await 时产生重复的未处理拒绝告警。
    void result.then(undefined, () => undefined);
    pending.set(item.toolCallId, {
      item,
      result,
      resolve: resolveResult,
      reject: rejectResult,
    });
    options.publish({
      type: 'interactionRequired',
      interaction:
        item.kind === 'approval'
          ? {
              type: 'approval',
              interactionId: item.toolCallId,
              item,
              occurredAt,
            }
          : {
              type: 'toolResult',
              interactionId: item.toolCallId,
              item,
              occurredAt,
            },
    });
  };

  const resume = (resolution: AgentResumeResult): void => {
    const interaction = pending.get(resolution.interactionId);
    if (interaction === undefined) {
      throw new Error(
        `Unknown or resolved Agent interaction ${resolution.interactionId}.`,
      );
    }
    if (resolution.type === 'rejected') {
      interaction.reject(
        new Error(`${resolution.error.code}: ${resolution.error.message}`),
      );
      return;
    }
    if (resolution.mode !== undefined) options.setMode(resolution.mode);
    if (resolution.type === 'approval') {
      if (interaction.item.kind !== 'approval') {
        throw new Error(
          `Interaction ${resolution.interactionId} requires a tool result.`,
        );
      }
      interaction.resolve({
        type: 'approval',
        approved: resolution.approved,
        ...(resolution.reason === undefined
          ? {}
          : { reason: resolution.reason }),
      });
      return;
    }
    if (interaction.item.kind !== 'tool-call') {
      throw new Error(
        `Interaction ${resolution.interactionId} requires an approval.`,
      );
    }
    interaction.resolve({ type: 'toolResult', result: resolution.result });
  };

  const resolveDeferred = async (
    deferred: ReadonlyArray<DeferredRunItem>,
  ): Promise<{
    readonly approvals: Record<
      string,
      { readonly approved: boolean; readonly reason?: string }
    >;
    readonly toolResults: Record<string, unknown>;
  }> => {
    const approvals: Record<
      string,
      { readonly approved: boolean; readonly reason?: string }
    > = {};
    const toolResults: Record<string, unknown> = {};
    for (const item of deferred) {
      if (item.kind === 'interrupted') {
        throw new Error(
          'Interrupted deferred items cannot be resumed by a Client.',
        );
      }
      const interaction = pending.get(item.toolCallId);
      if (interaction === undefined) {
        throw new Error(
          `Deferred item ${item.toolCallId} has no Agent interaction.`,
        );
      }
      const resolution = await interaction.result;
      pending.delete(item.toolCallId);
      if (item.kind === 'approval') {
        if (resolution.type !== 'approval') {
          throw new Error(
            `Approval ${item.toolCallId} received a tool result.`,
          );
        }
        approvals[item.toolCallId] = {
          approved: resolution.approved,
          ...(resolution.reason === undefined
            ? {}
            : { reason: resolution.reason }),
        };
        continue;
      }
      if (resolution.type !== 'toolResult') {
        throw new Error(
          `Deferred tool ${item.toolCallId} received an approval.`,
        );
      }
      toolResults[item.toolCallId] = resolution.result;
    }
    return { approvals, toolResults };
  };

  return {
    register,
    resume,
    resolveDeferred,
    interrupt(reason: string) {
      for (const interaction of pending.values()) {
        interaction.reject(new Error(`Agent interrupted: ${reason}`));
      }
    },
  };
}

function isFailure(result: EngineRunResult): boolean {
  const reason = result.finishReason;
  switch (reason) {
    case 'content-filter':
    case 'error':
    case 'no-progress':
    case 'unknown':
      return true;
    case 'length':
      return result.output.trim() === '';
    case 'stop':
    case 'tool-calls':
    case 'approval-required':
    case 'tool-result-required':
    case 'interrupted':
      return false;
    default:
      reason satisfies never;
      throw new Error(`Unhandled finish reason: ${String(reason)}`);
  }
}

function emptyUsage(): EngineRunResult['usage'] {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
  };
}

function addUsage(
  left: EngineRunResult['usage'],
  right: EngineRunResult['usage'],
): EngineRunResult['usage'] {
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    lastInputTokens: right.lastInputTokens ?? right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    toolCalls: left.toolCalls + right.toolCalls,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended) throw new Error('Cannot push to a completed event queue.');
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve({ done: false, value });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
