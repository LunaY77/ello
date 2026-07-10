import { AgentStreamBackpressureError } from '../public/errors.js';
import type { AgentStreamEvent } from '../public/events.js';
import type {
  AgentMessage,
  AgentRunResult,
  AgentStream,
} from '../public/types.js';

export const DEFAULT_AGENT_STREAM_BUFFER_CAPACITY = 1_024;

/**
 * 单生产者—单消费者的事件流实现。
 *
 * 内核作为生产者通过 `emit/complete/fail` 推送事件与终态，外部消费者
 * 通过 `for await...of`（异步迭代器）拉取事件，并通过 `final` Promise
 * 等待最终结果。核心是一个事件队列 + 一组等待者：
 * - 有人在等就直接交付，否则入队等待下次 `next`；
 * - `complete/fail` 关闭流并结算 `final`，唤醒所有等待者。
 */

/** 创建一个可外部结算的 Promise（deferred）。 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // 预挂一个 noop catch，避免未消费的 final 触发未处理拒绝告警。
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * {@link AgentStream} 的队列实现。
 *
 * 生产者通过 `emit/complete/fail` 推送状态，消费者通过异步迭代器与
 * `final` Promise 读取事件与最终结果。
 *
 * @param abortController 与本次 run 绑定的取消控制器，`abort` 经它转发。
 */
export class AgentEventStream implements AgentStream {
  /** 解析为最终运行结果的 Promise（成功 resolve，失败 reject）。 */
  readonly final: Promise<AgentRunResult>;
  /** 支撑 `final` 的内部 deferred。 */
  private readonly result = createDeferred<AgentRunResult>();
  /** 已产出但尚无人消费的事件缓冲队列。 */
  private readonly queue: AgentStreamEvent[] = [];
  /** 调用了 `next` 但暂无事件可取、正在挂起等待的消费者。 */
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<AgentStreamEvent>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  /** 流是否已关闭（complete 或 fail 之后置真）。 */
  private closed = false;
  /** 流失败原因；缓冲事件消费完后由迭代器抛出。 */
  private failure: unknown | undefined;

  constructor(
    private readonly abortController: AbortController,
    private readonly onSteer: (message: AgentMessage) => void = () => {},
    private readonly capacity = DEFAULT_AGENT_STREAM_BUFFER_CAPACITY,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `Agent stream maxBufferedEvents must be a positive integer: ${capacity}`,
      );
    }
    this.final = this.result.promise;
  }

  /** 自身即异步迭代器。 */
  [Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent> {
    return this;
  }

  /**
   * 拉取下一个事件。
   *
   * 队列有积压则立即返回；否则若已关闭返回 `done`，再否则挂起为等待者。
   */
  next(): Promise<IteratorResult<AgentStreamEvent>> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ done: false, value: queued });
    }
    if (this.closed) {
      if (this.failure !== undefined) {
        return Promise.reject(this.failure);
      }
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * 推送一个事件。
   *
   * 若有挂起的等待者则直接交付，否则入队等待下一次 `next`。
   *
   * @param event 待推送的事件。
   */
  emit(event: AgentStreamEvent): void {
    if (this.closed) {
      throw new Error('Cannot emit an event after the agent stream closed.');
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: event });
      return;
    }
    if (this.queue.length === this.capacity) {
      throw new AgentStreamBackpressureError(this.capacity);
    }
    this.queue.push(event);
  }

  /**
   * 标记流成功完成。
   *
   * @param result 最终运行结果，用于结算 `final`。
   */
  complete(result: AgentRunResult): void {
    this.result.resolve(result);
    this.close();
  }

  /**
   * 标记流失败。
   *
   * @param error 失败原因，会 reject `final` 并拒绝所有挂起的等待者。
   */
  fail(error: unknown, terminalEvent?: AgentStreamEvent): void {
    if (this.closed) {
      return;
    }
    if (terminalEvent !== undefined) {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve({ done: false, value: terminalEvent });
      } else if (this.queue.length < this.capacity) {
        this.queue.push(terminalEvent);
      }
    }
    this.result.reject(error);
    this.failure = error;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  /** 追加运行中引导消息，供下一回合抽取。 */
  steer(message: AgentMessage): void {
    if (this.closed) {
      return;
    }
    this.onSteer(message);
  }

  /** 触发取消：转发到绑定的 `AbortController`。 */
  abort(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  /** 关闭流：置关闭标志并以 `done` 唤醒所有挂起的等待者。 */
  private close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }
}
