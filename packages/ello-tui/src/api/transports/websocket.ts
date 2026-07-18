import WebSocket from 'ws';

import type { ClientTransport } from '../transport.js';

import { AsyncByteQueue } from './async-byte-queue.js';

export class WebSocketTransport implements ClientTransport {
  readonly kind = 'websocket' as const;
  private readonly incoming = new AsyncByteQueue();
  private closed = false;
  private readonly closeTimeoutMs = 1_000;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      this.incoming.push(buffer);
    });
    socket.once('close', () => this.incoming.end());
    socket.once('error', (error) => this.incoming.fail(error));
  }

  static connect(
    endpoint: string,
    token?: string,
  ): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint, {
        headers:
          token === undefined ? undefined : { authorization: `Bearer ${token}` },
      });
      const onError = (error: Error) => reject(error);
      socket.once('error', onError);
      socket.once('open', () => {
        socket.off('error', onError);
        resolve(new WebSocketTransport(socket));
      });
    });
  }

  messages(): AsyncIterable<Uint8Array> {
    return this.incoming;
  }

  send(message: Uint8Array): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket transport is closed.'));
    }
    return new Promise((resolve, reject) => {
      this.socket.send(message, (error?: Error | null) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.incoming.end();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.socket.terminate();
        finish();
      }, this.closeTimeoutMs);
      timer.unref();
      this.socket.once('close', finish);
      this.socket.close(1000, 'client closed');
    });
  }
}
