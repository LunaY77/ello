/**
 * 会话运行时使用的最小异步事件分发器。
 */
export class EventStream<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  /**
   * 将事件暴露为异步迭代器，方便 CLI 和 TUI 消费方使用 `for await`。
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  /**
   * 将一个事件推给下一个等待者；没有消费者时先缓存在队列中。
   */
  push(event: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.queue.push(event);
  }

  /**
   * 关闭事件流，并结束所有等待中的读取。
   */
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  /**
   * 读取下一个已缓存事件；没有事件时等待新的事件推入。
   */
  private async next(): Promise<IteratorResult<T>> {
    const event = this.queue.shift();
    if (event !== undefined) {
      return { done: false, value: event };
    }
    if (this.closed) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
