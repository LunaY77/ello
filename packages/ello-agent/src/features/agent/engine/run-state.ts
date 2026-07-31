/**
 * 单次 engine run 的普通状态对象与线性生命周期阶段。
 *
 * `RunState` 只保存一次运行的可变数据和并发组件；初始化、回合开始、回合结算、停止判断、完成与
 * 失败分别由导出函数推进。loop 可以顺序阅读全部控制流，不需要通过大型 class 方法寻找状态转换。
 */
import { randomUUID } from 'node:crypto';

import type { EnvironmentHandle } from '../../environment/index.js';

import type {
  AgentFinishReason,
  AgentInput,
  AgentRunContext,
  AgentRunOptions,
  AgentRunResult,
  AgentUsage,
  CreateAgentOptions,
  DeferredRunResults,
  MessageCompactionReport,
  QueueDrainDiagnostic,
} from './contracts.js';
import { normalizeAgentError } from './errors.js';
import {
  AgentEventDispatcher,
  type AgentEventInput,
  type AgentEventMetadata,
  type EngineEvent,
  type ModelCompactor,
} from './events.js';
import { normalizeInput } from './messages.js';
import {
  availableModelInputTokens,
  type MessageBudgetAnchor,
} from './model-input.js';
import type {
  AgentMessage,
  AgentModelResponse,
  ModelAdapter,
  ModelInputDiagnostics,
} from './model.js';
import {
  addUsage,
  createEmptyUsage,
  createRunDiagnostics,
  createRunResult,
  createTurnDiagnostics,
  finishReasonForStop,
} from './result.js';
import { AgentRunControl, prepareResume } from './run-control.js';
import {
  AgentEventStream,
  DEFAULT_AGENT_STREAM_BUFFER_CAPACITY,
} from './stream.js';
import { ToolScheduler } from './tool-scheduler.js';
import { buildToolSet } from './tools.js';
import type { AgentToolCall } from './tools.js';

export interface AgentRunState {
  readonly messages: AgentMessage[];
  readonly budget: Record<string, unknown>;
  turn: number;
  readonly queueDiagnostics: QueueDrainDiagnostic[];
}

export type AgentTraceEvent =
  | Extract<
      EngineEvent,
      { type: 'run.started' | 'turn.started' | 'turn.completed' }
    >
  | (AgentEventMetadata & {
      readonly type: 'tool.started';
      readonly toolCallId: string;
      readonly name: string;
      readonly telemetryTag?: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.approval_requested';
      readonly toolCallId: string;
      readonly toolName: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'approval.required' | 'tool.deferred';
      readonly toolCallId: string;
      readonly toolName: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.completed';
      readonly toolCallId: string;
    })
  | (AgentEventMetadata & {
      readonly type: 'tool.failed';
      readonly toolCallId: string;
      readonly errorName: string;
      readonly errorMessage: string;
    })
  | (AgentEventMetadata & { readonly type: 'run.interrupted' })
  | (AgentEventMetadata & {
      readonly type: 'run.completed';
      readonly runId: string;
      readonly finishReason: AgentFinishReason;
      readonly usage: AgentUsage;
    })
  | (AgentEventMetadata & {
      readonly type: 'run.failed';
      readonly runId: string;
      readonly errorName: string;
      readonly errorMessage: string;
    });

export interface AgentTrace {
  readonly events: AgentTraceEvent[];
  readonly metadata: Record<string, unknown>;
}

export interface InternalAgentRunContext<
  TContext = unknown,
> extends AgentRunContext<TContext> {
  readonly state: AgentRunState;
  readonly trace: AgentTrace;
}

export interface AgentMessageQueue<TItem = AgentMessage> {
  readonly mode: AgentMessageQueueMode;
  readonly size: number;
  readonly hasItems: boolean;
  /**
   * 把新的输入按既定顺序加入 产品 Agent Agent engine 运行状态 模块 的待处理队列。
   *
   * Args:
   * - `item`: 要由 `push` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行状态 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  push(item: TItem): void;
  /**
   * 在 产品 Agent Agent engine 运行状态 模块 中执行 `drain` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  drain(): TItem[];
  /**
   * 按 产品 Agent Agent engine 运行状态 模块 的一致性约束执行 `clear` 状态变更。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行状态 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  clear(): void;
}

export type AgentMessageQueueMode = 'all' | 'one-at-a-time';

export type AgentRunControlStatus =
  | 'running'
  | 'waiting_approval'
  | 'waiting_tool_result'
  | 'interrupted'
  | 'completed'
  | 'failed';

export type LoopStopReason =
  | 'natural-completed'
  | 'max-turns'
  | 'waiting-approval'
  | 'waiting-tool-result'
  | 'interrupted'
  | 'no-progress'
  | 'error';

export interface RunTurn {
  readonly index: number;
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly beforeModelMessages: AgentMessage[];
  readonly resume?: DeferredRunResults;
  readonly skipModel?: 'interrupted';
}

export interface RunState {
  readonly config: CreateAgentOptions;
  readonly input: AgentInput;
  readonly options: AgentRunOptions;
  readonly environment: EnvironmentHandle;
  readonly modelAdapter: ModelAdapter;
  readonly abortController: AbortController;
  readonly runId: string;
  readonly stream: AgentEventStream;
  readonly signal: AbortSignal;
  readonly metadata: Record<string, unknown>;
  readonly state: AgentRunState;
  readonly trace: AgentTrace;
  readonly ctx: InternalAgentRunContext;
  readonly runControl: AgentRunControl;
  readonly tools: ReturnType<typeof buildToolSet>;
  readonly toolScheduler: ToolScheduler;
  readonly events: AgentEventDispatcher;
  readonly maxTurns: number | undefined;
  readonly newMessages: AgentMessage[];
  resumeForFirstTurn: DeferredRunResults | undefined;
  turns: import('./contracts.js').AgentTurnDiagnostics[];
  compactions: MessageCompactionReport[];
  toolCalls: AgentToolCall[];
  usage: AgentUsage;
  finalResponse: AgentModelResponse | undefined;
  stopReason: LoopStopReason;
  lastTurnNewMessages: AgentMessage[];
  lastTurnResponse: AgentModelResponse | undefined;
  /** 跨回合共享的前缀锚点，保证 provider 缓存断点下标稳定。 */
  readonly messageBudgetAnchor: MessageBudgetAnchor;
  readonly compactorState: {
    current: ModelCompactor | undefined;
  };
}

/**
 * 创建一次 run 的状态对象和并发组件。
 *
 * Args:
 * - `options.config`: Agent 创建时冻结的模型、工具、环境和观测配置。
 * - `options.input`: 当前 run 的历史与新增输入。
 * - `options.runOptions`: 当前 run 的 id、回合上限、中断和元数据。
 * - `options.environment`: 当前 Agent 持有的执行环境。
 * - `options.modelAdapter`: 当前 Agent 持有的模型 adapter。
 *
 * Returns:
 * - 返回尚未 setup、尚未发布 `run.started` 的普通状态对象。
 */
export function createRunState(options: {
  readonly config: CreateAgentOptions;
  readonly input: AgentInput;
  readonly runOptions: AgentRunOptions;
  readonly environment: EnvironmentHandle;
  readonly modelAdapter: ModelAdapter;
  readonly compactorState: RunState['compactorState'];
}): RunState {
  const configuredMaxTurns = options.runOptions.maxTurns;
  if (
    configuredMaxTurns !== undefined &&
    (!Number.isInteger(configuredMaxTurns) ||
      configuredMaxTurns === 0 ||
      configuredMaxTurns < -1)
  ) {
    throw new Error('maxTurns must be a positive integer or -1.');
  }
  const maxTurns = configuredMaxTurns === -1 ? undefined : configuredMaxTurns;
  const abortController = new AbortController();
  bridgeAbortSignal(options.runOptions.signal, abortController);
  const runId = options.runOptions.runId ?? randomUUID();
  const runControl = new AgentRunControl(runId);
  const stream = new AgentEventStream(
    abortController,
    (message) => runControl.pushSteering(message),
    options.config.stream?.maxBufferedEvents ??
      DEFAULT_AGENT_STREAM_BUFFER_CAPACITY,
  );
  const metadata = {
    ...(options.config.metadata ?? {}),
    ...(options.runOptions.metadata ?? {}),
  };
  const state: AgentRunState = {
    messages: [],
    budget: {},
    turn: 0,
    queueDiagnostics: [],
  };
  const trace: AgentTrace = { events: [], metadata: {} };
  const context =
    options.runOptions.context ??
    (typeof options.input === 'object' && !Array.isArray(options.input)
      ? options.input.context
      : undefined);
  const ctx: InternalAgentRunContext = {
    runId,
    agentName: options.config.name ?? 'agent',
    input: options.input,
    context,
    options: options.runOptions,
    environment: options.environment,
    metadata,
    signal: abortController.signal,
    state,
    trace,
  };
  validateToolCollections(
    options.config.executionTools,
    options.config.modelTools,
  );
  const tools = buildToolSet({ tools: options.config.modelTools });
  const toolScheduler = new ToolScheduler({
    runId,
    turnIndex: () => state.turn,
    tools: options.config.executionTools,
    callableToolNames: new Set(
      options.config.modelTools.map((tool) => tool.name),
    ),
    environment: options.environment,
    metadata,
    signal: abortController.signal,
  });
  const events = new AgentEventDispatcher(options.config, stream, ctx);
  return {
    config: options.config,
    input: options.input,
    options: options.runOptions,
    environment: options.environment,
    modelAdapter: options.modelAdapter,
    abortController,
    runId,
    stream,
    signal: abortController.signal,
    metadata,
    state,
    trace,
    ctx,
    runControl,
    tools,
    toolScheduler,
    events,
    maxTurns,
    newMessages: [],
    resumeForFirstTurn: undefined,
    turns: [],
    compactions: [],
    toolCalls: [],
    usage: createEmptyUsage(),
    finalResponse: undefined,
    stopReason: 'no-progress',
    lastTurnNewMessages: [],
    lastTurnResponse: undefined,
    messageBudgetAnchor: { index: 0 },
    compactorState: options.compactorState,
  };
}

/**
 * 初始化输入队列、resume 数据并发布 run.started。
 *
 * Args:
 * - `run`: `initializeRunState` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 产品 Agent Agent engine 运行状态 模块 的异步副作用完整提交后兑现，不返回业务值。
 *
 * Throws:
 * - 当 产品 Agent Agent engine 运行状态 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function initializeRunState(run: RunState): Promise<void> {
  const normalized = normalizeInput(run.input);
  for (const message of normalized.messages.slice(
    0,
    normalized.historyLength,
  )) {
    run.runControl.sessionQueue.push(message);
  }
  for (const message of normalized.messages.slice(normalized.historyLength)) {
    run.runControl.pushInput(message);
  }
  run.resumeForFirstTurn = await prepareResume(run, run.options.resume);
  await run.events.emit({ type: 'run.started', runId: run.runId });
}

/**
 * 执行 产品 Agent Agent engine 运行状态 模块 定义的 `canBeginRunTurn` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `run`: `canBeginRunTurn` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
 */
export function canBeginRunTurn(run: RunState): boolean {
  return (
    (run.maxTurns === undefined || run.turns.length < run.maxTurns) &&
    run.stopReason !== 'error'
  );
}

/**
 * 开始一个回合并按固定顺序抽取消息队列。
 *
 * Args:
 * - `run`: `beginRunTurn` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 产品 Agent Agent engine 运行状态 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function beginRunTurn(run: RunState): Promise<RunTurn> {
  const turnIndex = run.turns.length;
  run.state.turn = turnIndex;
  await run.events.emit({
    type: 'turn.started',
    runId: run.runId,
    turnIndex,
  });
  if (run.signal.aborted) {
    interruptRunState(run);
    return {
      index: turnIndex,
      queueDrains: [],
      beforeModelMessages: [...run.state.messages],
      skipModel: 'interrupted',
    };
  }
  const resume = turnIndex === 0 ? run.resumeForFirstTurn : undefined;
  const drained = run.runControl.drainNextTurn(resume);
  const sessionCount =
    drained.diagnostics.find((diagnostic) => diagnostic.queue === 'session')
      ?.count ?? 0;
  run.newMessages.push(...drained.messages.slice(sessionCount));
  run.state.queueDiagnostics.push(...drained.diagnostics);
  run.state.messages.push(...drained.messages);
  for (const diagnostic of drained.diagnostics) {
    await run.events.emit({
      type: 'queue.drained',
      runId: run.runId,
      queue: diagnostic.queue,
      count: diagnostic.count,
    });
  }
  return {
    index: turnIndex,
    queueDrains: drained.diagnostics,
    beforeModelMessages: [...run.state.messages],
    ...(resume === undefined ? {} : { resume }),
  };
}

/**
 * 结算一个回合并更新消息、usage、工具调用、诊断与停止原因。
 *
 * Args:
 * - `run`: `completeRunTurn` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `turn`: `completeRunTurn` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `inputDiagnostics`: `completeRunTurn` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `response`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
 * - `toolResults`: `completeRunTurn` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `stopReason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - Promise 在 产品 Agent Agent engine 运行状态 模块 的异步副作用完整提交后兑现，不返回业务值。
 */
export async function completeRunTurn(
  run: RunState,
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
  const newMessages = response === undefined ? [] : response.newMessages;
  const allNewMessages = [...newMessages, ...toolResults.messages];
  run.newMessages.push(...allNewMessages);
  run.state.messages.push(...allNewMessages);
  run.lastTurnNewMessages = allNewMessages;
  run.lastTurnResponse = response;
  run.toolCalls.push(...toolResults.toolCalls);
  if (response !== undefined) {
    run.finalResponse = response;
    run.usage = addUsage(run.usage, response.usage);
  }
  if (stopReason !== undefined) {
    run.stopReason = stopReason;
  } else if (toolResults.pendingCount > 0) {
    run.stopReason =
      run.runControl.status === 'waiting_tool_result'
        ? 'waiting-tool-result'
        : 'waiting-approval';
  }
  run.turns.push(
    createTurnDiagnostics({
      turn: turn.index,
      ...(inputDiagnostics === undefined
        ? {}
        : { modelInput: inputDiagnostics }),
      queueDrains: turn.queueDrains,
      finishReason: finishReasonForStop(run.stopReason, run),
      newMessageCount: allNewMessages.length,
    }),
  );
  await run.events.emit({ type: 'turn.completed', turnIndex: turn.index });
}

/**
 * 判断回合结束后是否应停止主循环。
 *
 * Args:
 * - `run`: `shouldStopRun` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
 */
export function shouldStopRun(run: RunState): boolean {
  if (run.signal.aborted || run.runControl.status === 'interrupted') {
    run.stopReason = 'interrupted';
    return true;
  }
  if (run.runControl.status === 'waiting_approval') {
    run.stopReason = 'waiting-approval';
    return true;
  }
  if (run.runControl.status === 'waiting_tool_result') {
    run.stopReason = 'waiting-tool-result';
    return true;
  }
  if (run.maxTurns !== undefined && run.turns.length >= run.maxTurns) {
    run.stopReason = 'max-turns';
    return true;
  }
  if (run.runControl.hasQueuedWork()) return false;
  if (run.lastTurnResponse?.finishReason === 'tool-calls') {
    if (run.lastTurnNewMessages.length > 0) return false;
    run.stopReason = 'no-progress';
    return true;
  }
  if (
    run.lastTurnResponse?.finishReason === 'stop' &&
    hasAssistantFinalAnswer(run.lastTurnNewMessages)
  ) {
    run.stopReason = 'natural-completed';
    return true;
  }
  if (run.lastTurnNewMessages.length === 0) {
    run.stopReason = 'no-progress';
    return true;
  }
  return false;
}

/**
 * 执行压缩、构造最终结果、发布终态事件并结束 stream。
 *
 * Args:
 * - `run`: `completeRunState` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 产品 Agent Agent engine 运行状态 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function completeRunState(run: RunState): Promise<AgentRunResult> {
  const diagnostics = createRunDiagnostics({
    run,
    turns: run.turns,
    compactions: run.compactions,
  });
  const result = createRunResult({
    run,
    diagnostics,
    newMessages: run.newMessages,
  });
  if (run.stopReason === 'interrupted') {
    await run.events.emit({
      type: 'run.interrupted',
      runId: run.runId,
      messages: [...run.state.messages],
    });
  }
  await run.events.complete(result);
  run.stream.complete(result);
  return result;
}

/**
 * 把未知异常发布成 run.failed，并确保 stream 以同一失败终结。
 *
 * Args:
 * - `run`: `failRunState` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `error`: 上游捕获的失败值；函数保留原始 cause 并转换为当前错误契约。
 *
 * Returns:
 * - Promise 在 产品 Agent Agent engine 运行状态 模块 的异步副作用完整提交后兑现，不返回业务值。
 */
export async function failRunState(
  run: RunState,
  error: unknown,
): Promise<void> {
  let failure = error;
  let event: Extract<AgentEventInput, { type: 'run.failed' }> = {
    type: 'run.failed',
    error: normalizeAgentError(error),
    partialMessages: [...run.state.messages],
  };
  let emitted: Extract<EngineEvent, { type: 'run.failed' }> | undefined;
  try {
    emitted = await run.events.fail(event);
  } catch (recorderError) {
    failure = recorderError;
    event = {
      type: 'run.failed',
      error: normalizeAgentError(recorderError),
      partialMessages: [...run.state.messages],
    };
  }
  if (emitted === undefined) emitted = await run.events.fail(event);
  run.stream.fail(failure, emitted);
}

/**
 * 执行 产品 Agent Agent engine 运行状态 模块 定义的 `interruptRunState` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `run`: `interruptRunState` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 产品 Agent Agent engine 运行状态 模块 的同步状态变更完成后返回，不产生业务结果。
 */
export function interruptRunState(run: RunState): void {
  run.runControl.pushDeferred({
    kind: 'interrupted',
    messages: [...run.state.messages],
    reason: String(run.signal.reason ?? 'Agent stream aborted.'),
  });
  run.stopReason = 'interrupted';
}

function bridgeAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
): void {
  if (signal === undefined) return;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return;
  }
  signal.addEventListener('abort', () => controller.abort(signal.reason), {
    once: true,
  });
}

/**
 * 在下一次模型调用前按当前完整消息快照执行上下文压缩，并发布开始与完成事件。
 *
 * Args:
 * - `run`: 当前 run 的可变状态；压缩成功后会原位替换模型消息并累计压缩报告。
 *
 * Returns:
 * - 压缩并替换消息时返回 `true`；无需压缩时返回 `false`。
 *
 * Throws:
 * - 压缩预算缺失、报告归属错误或压缩器执行失败时直接抛错。
 */
export async function compactRunMessages(run: RunState): Promise<boolean> {
  const compactor = run.config.compactor;
  if (compactor === undefined) return false;
  const modelInputBudget = run.config.modelInputBudget;
  if (modelInputBudget === undefined) {
    throw new Error(
      'Message compaction requires modelInputBudget.maxInputTokens.',
    );
  }
  const contextWindow = availableModelInputTokens(modelInputBudget);
  const modelCompactor = run.compactorState.current;
  const compactionId = randomUUID();
  let started = false;
  const compacted = await compactor.compact({
    messages: [...run.state.messages],
    contextWindow,
    signal: run.signal,
    compact: (input) => {
      if (modelCompactor === undefined) {
        throw new Error(
          'Context compaction requires an existing primary-agent model context.',
        );
      }
      return modelCompactor.compact(input);
    },
    onStart: async (input) => {
      started = true;
      await run.events.emit({
        type: 'context.compaction.started',
        compactionId,
        beforeMessageCount: input.beforeMessageCount,
        tokensBefore: input.tokensBefore,
      });
    },
  });
  if (compacted === null) return false;
  if (compacted.report.compactor !== compactor.name) {
    throw new Error(
      `Message compactor '${compactor.name}' returned report for '${compacted.report.compactor}'.`,
    );
  }
  run.state.messages.splice(
    0,
    run.state.messages.length,
    ...compacted.messages,
  );
  if (!started) {
    await run.events.emit({
      type: 'context.compaction.started',
      compactionId,
      beforeMessageCount: compacted.report.beforeMessageCount,
      tokensBefore: compacted.report.tokensBefore,
    });
  }
  run.compactions.push(compacted.report);
  if (compacted.usage !== undefined) {
    run.usage = addUsage(run.usage, compacted.usage);
  }
  await run.events.emit({
    type: 'context.compaction',
    compactionId,
    beforeMessageCount: compacted.report.beforeMessageCount,
    afterMessageCount: compacted.report.afterMessageCount,
    compactor: compacted.report.compactor,
    summary: compacted.report.summary,
    keptMessageCount: compacted.report.keptMessageCount,
    tokensBefore: compacted.report.tokensBefore,
    ...(compacted.report.metadata === undefined
      ? {}
      : { metadata: compacted.report.metadata }),
  });
  return true;
}

function validateToolCollections(
  executionTools: ReadonlyArray<{ readonly name: string }>,
  modelTools: ReadonlyArray<{ readonly name: string }>,
): void {
  if (executionTools.length === 0 || modelTools.length === 0) {
    throw new Error('executionTools and modelTools must both be non-empty.');
  }
  const executionNames = validateUniqueToolNames(
    executionTools,
    'executionTools',
  );
  validateUniqueToolNames(modelTools, 'modelTools');
  for (const tool of modelTools) {
    if (!executionNames.has(tool.name)) {
      throw new Error(
        `Model tool '${tool.name}' is not registered in executionTools.`,
      );
    }
  }
}

function validateUniqueToolNames(
  tools: ReadonlyArray<{ readonly name: string }>,
  collection: string,
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.name.trim() === '') {
      throw new Error(`${collection} contains an empty tool name.`);
    }
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool '${tool.name}' in ${collection}.`);
    }
    names.add(tool.name);
  }
  return names;
}

function hasAssistantFinalAnswer(
  messages: ReadonlyArray<AgentMessage>,
): boolean {
  return messages.some((message) =>
    message.role === 'assistant'
      ? typeof message.content === 'string'
        ? message.content.length > 0
        : message.content.length > 0
      : false,
  );
}
