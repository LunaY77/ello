import type { ModelMessage } from 'ai';

import { RunState } from '../state.js';

import type { AgentStreamEvent } from './events.js';
import {
  PartialTextAccumulator,
  closeUnreturnedToolCalls,
} from './recovery.js';

/** Agent 执行被中断。 */
export class AgentInterrupted extends Error {
  constructor(message = 'Agent execution was interrupted') {
    super(message);
    this.name = 'AgentInterrupted';
  }
}

/** AgentStreamer 构造参数。 */
export interface AgentStreamerOptions {
  run?: StreamRunLike | null;
}

/** streamer 需要的最小 run 形态。 */
export interface StreamRunLike {
  allMessages(): ModelMessage[];
  result?: { output?: unknown } | null;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * Queue-based async iterator, 支持中断和错误传播。
 */
export class AgentStreamer<
  TResult = unknown,
> implements AsyncIterable<AgentStreamEvent> {
  run: StreamRunLike | null;
  exception: unknown = null;
  private readonly queue: AgentStreamEvent[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<AgentStreamEvent>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly accumulator = new PartialTextAccumulator();
  private readonly deferredResult = createDeferred<TResult>();
  private done = false;
  private interrupted = false;

  constructor(options: AgentStreamerOptions = {}) {
    this.run = options.run ?? null;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<AgentStreamEvent>> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.accumulator.observe(queued);
      return { done: false, value: queued };
    }

    this.throwIfException();

    if (this.done) {
      return { done: true, value: undefined };
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** 将事件推入队列。 */
  enqueue(event: AgentStreamEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      this.accumulator.observe(event);
      waiter.resolve({ done: false, value: event });
      return;
    }
    this.queue.push(event);
  }

  /** 关联 producer task, 用于错误传播。 */
  addTask(task: Promise<unknown>): void {
    this.tasks.add(task);
    task
      .catch((error: unknown) => {
        this.fail(error);
      })
      .finally(() => {
        this.tasks.delete(task);
      });
  }

  /** 标记流结束。 */
  finish(): void {
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  /** 标记流失败。 */
  fail(error: unknown): void {
    this.exception = error;
    this.done = true;
    this.deferredResult.reject(error);
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  /** 设置最终 result。 */
  setResult(result: TResult): void {
    this.deferredResult.resolve(result);
  }

  /** 等待最终 result。 */
  result(): Promise<TResult> {
    return this.deferredResult.promise;
  }

  /** 立即中断流。 */
  interrupt(): void {
    this.interrupted = true;
    this.fail(new AgentInterrupted());
  }

  /** 如有异常则抛出。 */
  throwIfException(): void {
    if (this.exception !== null) {
      throw this.exception;
    }
  }

  /** 构建包含 partial response 的可恢复消息历史。 */
  recoverableMessages(): ModelMessage[] | null {
    if (this.run === null) {
      return null;
    }
    const messages = [...this.run.allMessages()];
    const partial = this.accumulator.buildResponse();
    if (partial !== null) {
      messages.push(partial);
    }
    return closeUnreturnedToolCalls(messages);
  }

  /** 获取 RunState。 */
  get state(): RunState | null {
    if (this.run === null) {
      return null;
    }
    return RunState.fromRunResult({
      output: this.run.result?.output,
      allMessages: () => this.run?.allMessages() ?? [],
    });
  }

  /** 是否已经被中断。 */
  get isInterrupted(): boolean {
    return this.interrupted;
  }
}
