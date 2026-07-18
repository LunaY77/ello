export class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  private readonly values: Uint8Array[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<Uint8Array>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  constructor(private readonly maxLength = 256) {}

  push(value: Uint8Array): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      if (this.values.length >= this.maxLength) {
        this.fail(new Error(`Transport inbound queue exceeds ${this.maxLength} messages.`));
        return;
      }
      this.values.push(value.slice());
    }
    else waiter.resolve({ done: false, value: value.slice() });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
