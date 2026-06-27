import type { AgentStreamEvent } from '../public/events.js';
import type { AgentRunResult, AgentStream } from '../public/types.js';

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
 * AgentStream 的队列实现。
 *
 * 生产者通过 emit()/complete()/fail() 推送状态，消费者通过 async iterator
 * 和 final promise 读取事件与最终结果。
 *
 * Args:
 *   abortController: 与本次 run 绑定的取消控制器。
 */
export class AgentEventStream implements AgentStream {
  readonly final: Promise<AgentRunResult>;
  private readonly result = createDeferred<AgentRunResult>();
  private readonly queue: AgentStreamEvent[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<AgentStreamEvent>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;

  constructor(private readonly abortController: AbortController) {
    this.final = this.result.promise;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
    return this;
  }

  next(): Promise<IteratorResult<AgentStreamEvent>> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ done: false, value: queued });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * 推送一个事件。
   *
   * Args:
   *   event: 稳定 AgentStreamEvent。
   */
  emit(event: AgentStreamEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: event });
      return;
    }
    this.queue.push(event);
  }

  /**
   * 标记流成功完成。
   *
   * Args:
   *   result: 最终 AgentRunResult。
   */
  complete(result: AgentRunResult): void {
    this.result.resolve(result);
    this.close();
  }

  /**
   * 标记流失败。
   *
   * Args:
   *   error: 失败原因，会 reject 等待中的 iterator 和 final。
   */
  fail(error: unknown): void {
    this.result.reject(error);
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  abort(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  private close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }
}
