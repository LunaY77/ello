import { TransportClosedError } from '../api/request-errors.js';
import type { ClientTransport } from '../api/transport.js';

interface QueueWaiter {
  readonly resolve: (result: IteratorResult<Uint8Array>) => void;
}

class AsyncMessageQueue {
  private readonly values: Uint8Array[] = [];
  private readonly waiters: QueueWaiter[] = [];
  private ended = false;

  push(value: Uint8Array): void {
    if (this.ended) throw new TransportClosedError();
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve({ done: false, value });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.waiters.push({ resolve }));
  }
}

class MemoryTransport implements ClientTransport {
  readonly kind = 'memory' as const;
  private peer: MemoryTransport | undefined;
  private readonly incoming = new AsyncMessageQueue();
  private closed = false;

  connect(peer: MemoryTransport): void {
    this.peer = peer;
  }

  messages(): AsyncIterable<Uint8Array> {
    const incoming = this.incoming;
    return {
      [Symbol.asyncIterator]() {
        return { next: () => incoming.next() };
      },
    };
  }

  async send(message: Uint8Array): Promise<void> {
    if (this.closed || this.peer === undefined || this.peer.closed) {
      throw new TransportClosedError();
    }
    // 测试 transport 也复制字节，避免发送方复用 buffer 造成假阳性。
    this.peer.incoming.push(message.slice());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.incoming.end();
    this.peer?.incoming.end();
  }
}

export function createMemoryTransportPair(): {
  readonly client: ClientTransport;
  readonly server: ClientTransport;
} {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.connect(server);
  server.connect(client);
  return { client, server };
}
