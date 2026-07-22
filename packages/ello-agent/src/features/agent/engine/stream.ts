/**
 * 本文件负责 agent feature 的流式背压与完成状态。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { AgentRunResult, AgentStream } from './contracts.js';
import { AgentStreamBackpressureError } from './errors.js';
import type { EngineEvent } from './events.js';
import type { AgentMessage } from './model.js';

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
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (resolve === undefined || reject === undefined) {
    throw new Error('Promise executor did not initialize deferred controls.');
  }
  // 迭代器也会传播同一失败；预挂 rejection observer 只避免未读取 final 时产生重复的进程级告警。
  void promise.then(undefined, () => undefined);
  return { promise, resolve, reject };
}

/**
 * {@link AgentStream} 的队列实现。
 *
 * 生产者通过 `emit/complete/fail` 推送状态，消费者通过异步迭代器与
 * `final` Promise 读取事件与最终结果。
 *
 * @param abortController 与当前 run 绑定的取消控制器，`abort` 经它转发。
 */
export class AgentEventStream implements AgentStream {
  /** 解析为最终运行结果的 Promise（成功 resolve，失败 reject）。 */
  readonly final: Promise<AgentRunResult>;
  /** 支撑 `final` 的内部 deferred。 */
  private readonly result = createDeferred<AgentRunResult>();
  /** 已产出但尚无人消费的事件缓冲队列。 */
  private readonly queue: EngineEvent[] = [];
  /** 调用了 `next` 但暂无事件可取、正在挂起等待的消费者。 */
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<EngineEvent>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  /** 流是否已关闭（complete 或 fail 之后置真）。 */
  private closed = false;
  /** 流失败原因；缓冲事件消费完后由迭代器抛出。 */
  private failure: unknown | undefined;

  /**
   * 创建 `AgentEventStream`，由该实例独占 产品 Agent Agent engine 流控制 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `abortController`: `constructor AgentEventStream` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `onSteer`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   * - `capacity`: 当前操作使用的数量上限；超出限制时直接失败或按契约截断。
   */
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

  /**
   * 自身即异步迭代器。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `[Symbol.asyncIterator]` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    return this;
  }

  /**
   * 拉取下一个事件。
   *
   * 队列有积压则立即返回；否则若已关闭返回 `done`，再否则挂起为等待者。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 产品 Agent Agent engine 流控制 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  next(): Promise<IteratorResult<EngineEvent>> {
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
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   *
   * Returns:
   * - 产品 Agent Agent engine 流控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  emit(event: EngineEvent): void {
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
   *
   * Args:
   * - `result`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
   *
   * Returns:
   * - 产品 Agent Agent engine 流控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  complete(result: AgentRunResult): void {
    this.result.resolve(result);
    this.close();
  }

  /**
   * 标记流失败。
   *
   * @param error 失败原因，会 reject `final` 并拒绝所有挂起的等待者。
   *
   * Args:
   * - `error`: 上游捕获的失败值；函数保留原始 cause 并转换为当前错误契约。
   * - `terminalEvent`: `fail` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 产品 Agent Agent engine 流控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  fail(error: unknown, terminalEvent?: EngineEvent): void {
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

  /**
   * 追加运行中引导消息，供下一回合抽取。
   *
   * Args:
   * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   *
   * Returns:
   * - 产品 Agent Agent engine 流控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  steer(message: AgentMessage): void {
    if (this.closed) {
      return;
    }
    this.onSteer(message);
  }

  /**
   * 触发取消：转发到绑定的 `AbortController`。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 产品 Agent Agent engine 流控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  abort(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  /**
   * 关闭流：置关闭标志并以 `done` 唤醒所有挂起的等待者。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 产品 Agent Agent engine 流控制 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  private close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }
}
