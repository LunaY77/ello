/**
 * 本文件实现 transport 共用的有限字节消息队列。
 *
 * 队列同时限制消息数与已复制字节数；超过任一限制立即失败，不能用无限数组吸收慢消费者压力。
 */

/** 单 consumer 异步队列；每次入队复制字节，避免发送方复用 buffer。 */
export class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  private readonly values: Uint8Array[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<Uint8Array>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;
  private queuedBytes = 0;

  constructor(
    private readonly maxLength = 256,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
      throw new Error('Transport queue message limit must be positive.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Transport queue byte limit must be positive.');
    }
  }

  /**
   * 推送一条完整消息。
   *
   * Args:
   * - `value`: transport 收到的一条完整消息字节。
   *
   * Returns:
   * - 成功交付或入队返回 true；队列已结束或超限返回 false。
   */
  push(value: Uint8Array): boolean {
    if (this.ended) return false;
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      if (
        this.values.length >= this.maxLength ||
        this.queuedBytes + value.byteLength > this.maxBytes
      ) {
        this.fail(
          new Error(
            `Transport inbound queue exceeds ${this.maxLength} messages or ${this.maxBytes} bytes.`,
          ),
        );
        return false;
      }
      const copy = value.slice();
      this.values.push(copy);
      this.queuedBytes += copy.byteLength;
    } else waiter.resolve({ done: false, value: value.slice() });
    return true;
  }

  /** 正常结束队列，并让所有等待中的 iterator 收到 done。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  /**
   * 以明确错误终止队列。
   *
   * Args:
   * - `error`: 需要传播给等待中或后续 iterator 的失败原因。
   */
  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  /** 返回消费当前队列的唯一异步 iterator。 */
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.queuedBytes -= value.byteLength;
          return Promise.resolve({ done: false, value });
        }
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
