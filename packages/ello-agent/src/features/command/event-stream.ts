/**
 * Command Run 使用的异步事件流适配器。
 *
 * 执行结果与有序事件共享同一生命周期，消费者可先遍历事件再读取最终 transition。
 */

/** 把事件发布函数包装成可迭代执行结果。 */
export function createEventExecution<TEvent, TResult>(
  run: (emit: (event: TEvent) => Promise<void>) => Promise<TResult>,
): AsyncIterable<TEvent> & { readonly result: Promise<TResult> } {
  const queue = new AsyncEventQueue<TEvent>();
  const result = run(async (event) => queue.push(event)).then(
    (transition) => {
      queue.end();
      return transition;
    },
    (error) => {
      queue.fail(error);
      throw error;
    },
  );
  return {
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    result,
  };
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): Promise<void> {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve({ done: false, value });
    return Promise.resolve();
  }

  end(): void {
    this.ended = true;
    this.flush();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.ended = true;
    this.flush();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) {
      return this.failure === undefined
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }

  private flush(): void {
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure === undefined)
        waiter.resolve({ done: true, value: undefined });
      else waiter.reject(this.failure);
    }
  }
}
