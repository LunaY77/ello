/**
 * 单次运行的会话状态机。
 *
 * 一次 `run` / `stream` / `resume` 对应一个 {@link RunSession} 实例，集中承载本次
 * 运行的全部可变状态：消息历史、回合诊断、工具调用、用量、停止原因，以及事件流、
 * 中断信号、排队控制器、工具调度器等协作部件。回合循环 `runAgentLoop` 仅按
 * `start` → `startTurn` → `finishTurn` → `shouldStopAfterTurn` → `finish` 的次序
 * 调用本类方法来推进状态，从而把「循环节奏」与「状态管理」清晰分离。
 */
import { randomUUID } from 'node:crypto';

import { AiSdkModelAdapter } from '../adapters/ai-sdk.js';
import { normalizeAgentError } from '../public/errors.js';
import type {
  AgentEnvironment,
  AgentInput,
  AgentMessage,
  AgentModelResponse,
  AgentRunContext,
  AgentRunOptions,
  AgentRunResult,
  AgentRunState,
  AgentToolCall,
  AgentTrace,
  AgentTurnDiagnostics,
  CreateAgentOptions,
  DeferredRunResults,
  ModelAdapter,
  ModelInputDiagnostics,
  QueueDrainDiagnostic,
} from '../public/types.js';

import { AgentEventDispatcher } from './events.js';
import { diffNewMessages, normalizeInput } from './messages.js';
import {
  createRunDiagnostics,
  createRunResult,
  createTurnDiagnostics,
  finishReasonForStop,
} from './result.js';
import { prepareResume } from './resume.js';
import { AgentRunControl } from './run-control.js';
import {
  compactSession,
  loadSessionMessages,
  saveSessionResult,
} from './session-runtime.js';
import { AgentEventStream } from './stream.js';
import { buildToolSet } from './tool-runner.js';
import { ToolScheduler } from './tool-scheduler.js';
import { addUsage, createEmptyUsage } from './usage.js';

/**
 * 回合循环的停止原因。
 *
 * - `natural-completed`：模型给出最终回答，自然结束；
 * - `max-turns`：达到回合上限；
 * - `waiting-approval`：有工具调用待审批，运行挂起等待恢复；
 * - `interrupted`：被中断信号终止；
 * - `no-progress`：本回合未产生新进展（防止空转死循环）；
 * - `error`：运行过程中出错。
 */
export type LoopStopReason =
  | 'natural-completed'
  | 'max-turns'
  | 'waiting-approval'
  | 'interrupted'
  | 'no-progress'
  | 'error';

/** 单个回合的上下文：开始时确定，结束时回传给 `finishTurn` 用于结算。 */
export interface RunTurn {
  /** 回合序号（从 0 开始）。 */
  readonly index: number;
  /** 本回合各队列的抽取诊断。 */
  readonly queueDrains: QueueDrainDiagnostic[];
  /** 调用模型前的消息快照，用于事后 diff 出模型新增的消息。 */
  readonly beforeModelMessages: AgentMessage[];
  /** 首回合携带的 resume 恢复数据（如有）。 */
  readonly resume?: DeferredRunResults;
  /** 若回合开始即被中断，则标记跳过模型调用。 */
  readonly skipModel?: 'interrupted';
}

/**
 * 创建运行会话，并把外部中断信号桥接到内部 `AbortController`。
 *
 * 若调用方传入的 `signal` 已中断则立即中断；否则监听其 `abort` 事件转发到内部
 * 控制器，使内核统一通过单一 `signal` 感知中断。
 */
export function createRunSession(options: {
  readonly config: CreateAgentOptions;
  readonly input: AgentInput;
  readonly runOptions: AgentRunOptions;
  readonly environment: AgentEnvironment;
  readonly modelAdapter: ModelAdapter;
}): RunSession {
  const abortController = new AbortController();
  if (options.runOptions.signal !== undefined) {
    if (options.runOptions.signal.aborted) {
      abortController.abort(options.runOptions.signal.reason);
    } else {
      options.runOptions.signal.addEventListener(
        'abort',
        () => abortController.abort(options.runOptions.signal?.reason),
        { once: true },
      );
    }
  }
  return new RunSession({ ...options, abortController });
}

/**
 * 承载一次运行全部可变状态与协作部件的会话对象。
 *
 * 其方法对应回合循环的各个阶段；字段分两类：构造期确定的只读协作部件，以及随回合
 * 推进而累积的可变状态（消息、回合诊断、工具调用、用量、停止原因等）。
 */
export class RunSession {
  /** 本次运行的唯一标识。 */
  readonly runId = randomUUID();
  /** 对外事件流，回合事件与最终结果都经此发布。 */
  readonly stream: AgentEventStream;
  /** 中断信号，内核统一据此感知中断。 */
  readonly signal: AbortSignal;
  /** 合并自配置与运行选项的元数据（含 `sessionId`）。 */
  readonly metadata: Record<string, unknown>;
  /** 运行时状态：消息、预算、当前回合号、队列诊断。 */
  readonly state: AgentRunState;
  /** 运行追踪信息。 */
  readonly trace: AgentTrace;
  /** 暴露给工具/环境/观测者的运行上下文。 */
  readonly ctx: AgentRunContext;
  /** 排队与运行状态控制器。 */
  readonly runControl: AgentRunControl;
  /** 本次运行可用的工具集合。 */
  readonly tools;
  /** 工具调度器，负责实际执行（含审批）工具调用。 */
  readonly toolScheduler: ToolScheduler;
  /** 事件分发器，向 stream 与观测者广播内核事件。 */
  readonly events: AgentEventDispatcher;
  /** 回合数上限（至少为 1，缺省 8）。 */
  readonly maxTurns: number;

  /** 启动时载入的会话历史，用于计算需追加持久化的消息区间。 */
  loadedSessionMessages: AgentMessage[] = [];
  /** 仅供首个回合使用的 resume 恢复数据。 */
  resumeForFirstTurn: DeferredRunResults | undefined;
  /** 已完成回合的诊断累积。 */
  turns: AgentTurnDiagnostics[] = [];
  /** 本次运行累计的工具调用。 */
  toolCalls: AgentToolCall[] = [];
  /** 累计 token 用量。 */
  usage = createEmptyUsage();
  /** 最后一次模型响应（构建最终结果时使用）。 */
  finalResponse: AgentModelResponse | undefined;
  /** 当前停止原因，默认 `no-progress` 直到被明确改写。 */
  stopReason: LoopStopReason = 'no-progress';
  /** 上一回合新增的消息（含模型输出与工具结果），用于去留判定。 */
  lastTurnNewMessages: AgentMessage[] = [];
  /** 上一回合的模型响应，用于读取 finishReason。 */
  lastTurnResponse: AgentModelResponse | undefined;

  /** 从入参装配各协作部件并初始化运行上下文与状态。 */
  constructor(
    readonly optionsBundle: {
      readonly config: CreateAgentOptions;
      readonly input: AgentInput;
      readonly runOptions: AgentRunOptions;
      readonly environment: AgentEnvironment;
      readonly modelAdapter: ModelAdapter;
      readonly abortController: AbortController;
    },
  ) {
    this.config = optionsBundle.config;
    this.input = optionsBundle.input;
    this.options = optionsBundle.runOptions;
    this.environment = optionsBundle.environment;
    this.modelAdapter = optionsBundle.modelAdapter;
    this.abortController = optionsBundle.abortController;
    this.signal = this.abortController.signal;
    this.runControl = new AgentRunControl(this.runId);
    this.stream = new AgentEventStream(this.abortController, (message) => {
      this.runControl.pushSteering(message);
    });
    this.metadata = {
      ...(this.config.metadata ?? {}),
      ...(this.options.metadata ?? {}),
      ...(this.options.sessionId !== undefined
        ? { sessionId: this.options.sessionId }
        : {}),
    };
    this.state = {
      messages: [],
      budget: {},
      turn: 0,
      queueDiagnostics: [],
    };
    this.trace = { events: [], metadata: {} };
    this.ctx = {
      runId: this.runId,
      agentName: this.config.name ?? 'agent',
      ...(this.options.sessionId !== undefined
        ? { sessionId: this.options.sessionId }
        : {}),
      input: this.input,
      context:
        this.options.context ??
        (typeof this.input === 'object' && !Array.isArray(this.input)
          ? this.input.context
          : undefined),
      options: this.options,
      environment: this.environment,
      metadata: this.metadata,
      signal: this.signal,
      state: this.state,
      trace: this.trace,
    };
    this.tools = buildToolSet({ tools: this.config.tools ?? [] });
    this.toolScheduler = new ToolScheduler({
      runId: this.runId,
      tools: this.config.tools ?? [],
      environment: this.environment,
      metadata: this.metadata,
    });
    this.events = new AgentEventDispatcher(this.config, this.stream, this.ctx);
    this.maxTurns = Math.max(1, this.options.maxTurns ?? 8);
  }

  /** 不变的创建配置。 */
  readonly config: CreateAgentOptions;
  /** 本次运行的初始输入。 */
  readonly input: AgentInput;
  /** 本次运行的选项。 */
  readonly options: AgentRunOptions;
  /** 运行环境。 */
  readonly environment: AgentEnvironment;
  /** 模型适配器。 */
  readonly modelAdapter: ModelAdapter;
  /** 内部中断控制器。 */
  readonly abortController: AbortController;

  /**
   * 启动运行：环境初始化、发布 `run.started`、载入会话历史并入队各来源消息，
   * 最后准备好首回合可能需要的 resume 恢复数据。
   */
  async start(): Promise<void> {
    await this.environment.setup?.(this.ctx);
    await this.events.emit({ type: 'run.started', runId: this.runId });
    this.loadedSessionMessages = await loadSessionMessages({
      config: this.config,
      ...(this.options.sessionId !== undefined
        ? { sessionId: this.options.sessionId }
        : {}),
    });
    for (const message of this.loadedSessionMessages) {
      this.runControl.sessionQueue.push(message);
    }
    for (const message of normalizeInput(this.input)) {
      this.runControl.pushInput(message);
    }
    for (const message of this.options.messages ?? []) {
      this.runControl.pushInput(message);
    }
    this.resumeForFirstTurn = await prepareResume(this, this.options.resume);
  }

  /** 是否还能开新回合：未达回合上限且未处于错误状态。 */
  canStartTurn(): boolean {
    return this.turns.length < this.maxTurns && this.stopReason !== 'error';
  }

  /**
   * 开始一个回合：发布 `turn.started`，若已中断则标记跳过模型；否则按需带入首回合
   * 的 resume 数据，抽取本回合消息并入状态，最后返回回合上下文。
   */
  async startTurn(): Promise<RunTurn> {
    const turnIndex = this.turns.length;
    (this.state as { turn: number }).turn = turnIndex;
    await this.events.emit({
      type: 'turn.started',
      runId: this.runId,
      turnIndex,
    });
    // 回合伊始即检测到中断：保存现场并返回跳过模型的标记，由循环负责收尾。
    if (this.signal.aborted) {
      this.markInterrupted();
      return {
        index: turnIndex,
        queueDrains: [],
        beforeModelMessages: [...this.state.messages],
        skipModel: 'interrupted',
      };
    }
    // resume 恢复数据仅在首回合注入。
    const resume = turnIndex === 0 ? this.resumeForFirstTurn : undefined;
    const drained = this.runControl.drainNextTurn(resume);
    this.state.queueDiagnostics.push(...drained.diagnostics);
    this.state.messages.push(...drained.messages);
    for (const diagnostic of drained.diagnostics) {
      await this.events.emit({
        type: 'queue.drained',
        runId: this.runId,
        queue: diagnostic.queue,
        count: diagnostic.count,
      });
    }
    return {
      index: turnIndex,
      queueDrains: drained.diagnostics,
      beforeModelMessages: [...this.state.messages],
      ...(resume !== undefined ? { resume } : {}),
    };
  }

  /**
   * 结算一个回合：把模型新增消息与工具结果并入状态，累积工具调用与用量，
   * 据情设定停止原因（显式给定优先，否则有待审批则置 `waiting-approval`），
   * 记录回合诊断并发布 `turn.completed`。
   */
  async finishTurn(
    turn: RunTurn,
    inputDiagnostics: ModelInputDiagnostics | undefined,
    response: AgentModelResponse | undefined,
    toolResults: {
      readonly messages: AgentMessage[];
      readonly toolCalls: AgentToolCall[];
      readonly pendingCount: number;
    },
    stopReason?: LoopStopReason,
  ): Promise<void> {
    // 模型新增消息：优先用响应自报的 newMessages，否则与回合前快照 diff 得出。
    const newMessages =
      response?.newMessages ??
      (response === undefined
        ? []
        : diffNewMessages(turn.beforeModelMessages, response.messages));
    const allNewMessages = [...newMessages, ...toolResults.messages];
    this.state.messages.push(...allNewMessages);
    this.lastTurnNewMessages = allNewMessages;
    this.lastTurnResponse = response;
    this.toolCalls.push(...toolResults.toolCalls);
    if (response !== undefined) {
      this.finalResponse = response;
      this.usage = addUsage(this.usage, response.usage);
    }
    // 停止原因：调用方显式指定时直接采用；否则若有待审批工具调用则置为待审批。
    if (stopReason !== undefined) {
      this.stopReason = stopReason;
    } else if (toolResults.pendingCount > 0) {
      this.stopReason = 'waiting-approval';
    }
    this.turns.push(
      createTurnDiagnostics({
        turn: turn.index,
        ...(inputDiagnostics !== undefined
          ? { modelInput: inputDiagnostics }
          : {}),
        queueDrains: turn.queueDrains,
        finishReason: finishReasonForStop(this.stopReason, this),
        newMessageCount: allNewMessages.length,
      }),
    );
    await this.events.emit({ type: 'turn.completed', turnIndex: turn.index });
  }

  /**
   * 回合结束后判断是否应停止循环，并据此设定 `stopReason`。
   *
   * 优先级：中断 → 待审批 → 达到回合上限 → 仍有排队工作（继续）→ 依据上一回合的
   * finishReason 判断（请求工具调用则续跑，但若无任何新进展则判为空转停止；自然
   * 给出最终回答则完成）→ 无新消息兜底为空转停止。
   */
  shouldStopAfterTurn(): boolean {
    // 中断：信号已触发或控制器已标记中断。
    if (this.signal.aborted || this.runControl.status === 'interrupted') {
      this.stopReason = 'interrupted';
      return true;
    }
    // 待审批：有工具调用挂起，等待外部恢复。
    if (this.runControl.status === 'waiting_approval') {
      this.stopReason = 'waiting-approval';
      return true;
    }
    // 达到回合上限。
    if (this.turns.length >= this.maxTurns) {
      this.stopReason = 'max-turns';
      return true;
    }
    // 还有排队消息要处理：继续下一回合。
    if (this.runControl.hasQueuedWork()) {
      return false;
    }
    // 模型请求继续调用工具：有新进展则续跑，否则视为空转防死循环。
    if (this.lastTurnResponse?.finishReason === 'tool-calls') {
      if (this.lastTurnNewMessages.length > 0) {
        return false;
      }
      this.stopReason = 'no-progress';
      return true;
    }
    // 模型正常停止且给出了非空最终回答：自然完成。
    if (
      this.lastTurnResponse?.finishReason === 'stop' &&
      hasAssistantFinalAnswer(this.lastTurnNewMessages)
    ) {
      this.stopReason = 'natural-completed';
      return true;
    }
    // 本回合没有任何新消息：兜底为空转停止。
    if (this.lastTurnNewMessages.length === 0) {
      this.stopReason = 'no-progress';
      return true;
    }
    return false;
  }

  /**
   * 收尾运行：尝试压缩会话、汇总诊断与最终结果、把新增消息追加持久化，
   * 中断时另发 `run.interrupted`，最终发布 `run.completed` 并完结事件流。
   */
  async finish(): Promise<AgentRunResult> {
    const compactions = await compactSession({
      config: this.config,
      ctx: this.ctx,
      ...(this.options.sessionId !== undefined
        ? { sessionId: this.options.sessionId }
        : {}),
    });
    const diagnostics = createRunDiagnostics({
      run: this,
      turns: this.turns,
      compactions,
    });
    const result = createRunResult({ run: this, diagnostics });
    // 仅持久化相对载入历史新增的部分，避免重复写入既有会话历史。
    const messagesToAppend = result.messages.slice(
      this.loadedSessionMessages.length,
    );
    await saveSessionResult({
      config: this.config,
      result,
      messagesToAppend,
    });
    if (this.stopReason === 'interrupted') {
      await this.events.emit({
        type: 'run.interrupted',
        runId: this.runId,
        messages: [...this.state.messages],
      });
    }
    await this.events.emit({ type: 'run.completed', result });
    this.stream.complete(result);
    return result;
  }

  /** 运行失败：归一化错误、发布 `run.failed`（附带部分消息）并使事件流失败。 */
  async fail(error: unknown): Promise<void> {
    const normalized = normalizeAgentError(error);
    await this.events.emit({
      type: 'run.failed',
      error: normalized,
      partialMessages: [...this.state.messages],
    });
    this.stream.fail(error);
  }

  /**
   * 标记运行被中断：以延迟项形式保存中断现场（当前消息与中断原因），
   * 以便后续可恢复，并将停止原因置为 `interrupted`。
   */
  markInterrupted(): void {
    this.runControl.pushDeferred({
      kind: 'interrupted',
      messages: [...this.state.messages],
      reason: String(this.signal.reason ?? 'Agent stream aborted.'),
    });
    this.stopReason = 'interrupted';
  }
}

/** 默认模型适配器：基于 AI SDK 的实现。 */
export function defaultModelAdapter(): ModelAdapter {
  return new AiSdkModelAdapter();
}

/** 判断消息中是否存在内容非空的 assistant 消息（即模型给出了最终回答）。 */
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
