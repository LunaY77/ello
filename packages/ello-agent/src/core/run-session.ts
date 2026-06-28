import { randomUUID } from 'node:crypto';

import { AiSdkModelAdapter } from '../adapters/ai-sdk.js';
import { normalizeAgentError } from '../public/errors.js';
import type {
  AgentEnvironment,
  AgentInput,
  AgentMemoryItem,
  AgentMessage,
  AgentModelResponse,
  AgentRunContext,
  AgentRunDiagnostics,
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
import { observeRunCompleted, observeRunFailed } from './memory-runtime.js';
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

export type LoopStopReason =
  | 'natural-completed'
  | 'max-turns'
  | 'waiting-approval'
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

export class RunSession {
  readonly runId = randomUUID();
  readonly stream: AgentEventStream;
  readonly signal: AbortSignal;
  readonly metadata: Record<string, unknown>;
  readonly state: AgentRunState;
  readonly trace: AgentTrace;
  readonly ctx: AgentRunContext;
  readonly runControl: AgentRunControl;
  readonly tools;
  readonly toolScheduler: ToolScheduler;
  readonly events: AgentEventDispatcher;
  readonly maxTurns: number;

  loadedSessionMessages: AgentMessage[] = [];
  resumeForFirstTurn: DeferredRunResults | undefined;
  turns: AgentTurnDiagnostics[] = [];
  toolCalls: AgentToolCall[] = [];
  usage = createEmptyUsage();
  finalResponse: AgentModelResponse | undefined;
  stopReason: LoopStopReason = 'no-progress';
  lastTurnNewMessages: AgentMessage[] = [];
  lastTurnResponse: AgentModelResponse | undefined;
  memoryRetrieved = false;
  memoryCache: readonly AgentMemoryItem[] = [];

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
    this.stream = new AgentEventStream(this.abortController);
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
    this.runControl = new AgentRunControl(this.runId);
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

  readonly config: CreateAgentOptions;
  readonly input: AgentInput;
  readonly options: AgentRunOptions;
  readonly environment: AgentEnvironment;
  readonly modelAdapter: ModelAdapter;
  readonly abortController: AbortController;

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

  canStartTurn(): boolean {
    return this.turns.length < this.maxTurns && this.stopReason !== 'error';
  }

  async startTurn(): Promise<RunTurn> {
    const turnIndex = this.turns.length;
    (this.state as { turn: number }).turn = turnIndex;
    await this.events.emit({
      type: 'turn.started',
      runId: this.runId,
      turnIndex,
    });
    if (this.signal.aborted) {
      this.markInterrupted();
      return {
        index: turnIndex,
        queueDrains: [],
        beforeModelMessages: [...this.state.messages],
        skipModel: 'interrupted',
      };
    }
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

  shouldStopAfterTurn(): boolean {
    if (this.signal.aborted || this.runControl.status === 'interrupted') {
      this.stopReason = 'interrupted';
      return true;
    }
    if (this.runControl.status === 'waiting_approval') {
      this.stopReason = 'waiting-approval';
      return true;
    }
    if (this.turns.length >= this.maxTurns) {
      this.stopReason = 'max-turns';
      return true;
    }
    if (this.runControl.hasQueuedWork()) {
      return false;
    }
    if (this.lastTurnResponse?.finishReason === 'tool-calls') {
      if (this.lastTurnNewMessages.length > 0) {
        return false;
      }
      this.stopReason = 'no-progress';
      return true;
    }
    if (
      this.lastTurnResponse?.finishReason === 'stop' &&
      hasAssistantFinalAnswer(this.lastTurnNewMessages)
    ) {
      this.stopReason = 'natural-completed';
      return true;
    }
    if (this.lastTurnNewMessages.length === 0) {
      this.stopReason = 'no-progress';
      return true;
    }
    return false;
  }

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
    const messagesToAppend = result.messages.slice(
      this.loadedSessionMessages.length,
    );
    await saveSessionResult({
      config: this.config,
      result,
      messagesToAppend,
    });
    await observeRunCompleted({
      config: this.config,
      run: this,
      result,
      diagnostics,
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

  async fail(error: unknown): Promise<void> {
    const normalized = normalizeAgentError(error);
    const diagnostics: AgentRunDiagnostics = {
      queueDrains: [...this.state.queueDiagnostics],
      pendingCount: this.runControl.deferredQueue.size,
    };
    await observeRunFailed({
      config: this.config,
      run: this,
      error: normalized,
      diagnostics,
    });
    await this.events.emit({
      type: 'run.failed',
      error: normalized,
      partialMessages: [...this.state.messages],
    });
    this.stream.fail(error);
  }

  markInterrupted(): void {
    this.runControl.pushDeferred({
      kind: 'interrupted',
      messages: [...this.state.messages],
      reason: String(this.signal.reason ?? 'Agent stream aborted.'),
    });
    this.stopReason = 'interrupted';
  }
}

export function defaultModelAdapter(): ModelAdapter {
  return new AiSdkModelAdapter();
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
