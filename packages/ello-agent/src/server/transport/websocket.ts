import type WebSocket from 'ws';

import { createEntityId } from '../../domain/ids.js';

import { AsyncByteQueue } from './async-byte-queue.js';
import type { AppServerTransport } from './transport.js';

export interface WebSocketTransportOptions {
  readonly connectionId?: string;
  readonly closeTimeoutMs?: number;
}

/** WebSocket 只负责把一帧转换成完整消息，RPC 解析仍由 RpcProcessor 完成。 */
export class WebSocketTransport implements AppServerTransport {
  readonly kind = 'websocket' as const;
  readonly connectionId: string;
  private readonly incoming = new AsyncByteQueue();
  private readonly closeTimeoutMs: number;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    options: WebSocketTransportOptions = {},
  ) {
    this.connectionId = options.connectionId ?? createEntityId('watch');
    this.closeTimeoutMs = options.closeTimeoutMs ?? 1_000;
    socket.on('message', (data) => this.incoming.push(toBytes(data)));
    socket.once('close', () => this.incoming.end());
    socket.once('error', (error) => this.incoming.fail(error));
  }

  messages(): AsyncIterable<Uint8Array> {
    return this.incoming;
  }

  send(message: Uint8Array): Promise<void> {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      return Promise.reject(new Error('WebSocket transport is closed.'));
    }
    return new Promise((resolve, reject) => {
      this.socket.send(message, (error?: Error | null) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
  }

  async close(reason = 'server closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.incoming.end();
    if (this.socket.readyState === this.socket.CLOSED) return;
    await new Promise<void>((resolve) => {
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
      this.socket.close(1000, reason);
    });
  }
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.from(data);
}
