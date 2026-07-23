/**
 * Transport 契约:只搬运完整 JSON-RPC message 与进程生命周期事件,
 * 不解析 method,不修改 payload。运行时只使用 Tauri sidecar 实现。
 */
export type AppTransportKind = 'desktop-sidecar';

export interface AppTransport {
  readonly kind: AppTransportKind;
  /** 完整消息流;transport 关闭时迭代结束,异常关闭时抛错。 */
  messages(): AsyncIterable<Uint8Array>;
  /** 发送一条完整 JSON-RPC message(UTF-8,不含帧分隔符)。 */
  send(message: Uint8Array): Promise<void>;
  /** 关闭底层连接/进程;必须幂等。 */
  close(reason: string): Promise<void>;
}

/** transport 在客户端主动 close 之外终止。 */
export class TransportClosedError extends Error {
  constructor(
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransportClosedError';
  }
}

/** 有界异步字节队列:messages() 的生产端。push 失败表示消费者已停止。 */
export class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  private readonly buffer: Uint8Array[] = [];
  private waiting: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;
  private bufferedBytes = 0;

  constructor(
    private readonly capacity = 1024,
    private readonly byteCapacity = 8 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('AsyncByteQueue capacity must be a positive integer.');
    }
    if (!Number.isSafeInteger(byteCapacity) || byteCapacity <= 0) {
      throw new Error('AsyncByteQueue byte capacity must be a positive integer.');
    }
  }

  push(chunk: Uint8Array): boolean {
    if (this.ended) return false;
    if (this.buffer.length >= this.capacity) return false;
    if (chunk.byteLength > this.byteCapacity - this.bufferedBytes) return false;
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.byteLength;
    this.wake();
    return true;
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const resolve = this.waiting;
    this.waiting = undefined;
    resolve?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      const chunk = this.buffer.shift();
      if (chunk !== undefined) {
        this.bufferedBytes -= chunk.byteLength;
        yield chunk;
        continue;
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}
