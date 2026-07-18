import { createConnection } from 'node:net';

import WebSocket from 'ws';

import type { ClientTransport } from '../transport.js';

import { AsyncByteQueue } from './async-byte-queue.js';

export class UnixTransport implements ClientTransport {
  readonly kind = 'unix' as const;
  private readonly incoming = new AsyncByteQueue();
  private readonly closeTimeoutMs = 1_000;
  private closed = false;

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

  static async connect(socketPath: string, token?: string): Promise<UnixTransport> {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket('ws://localhost/', {
        createConnection: () => createConnection(socketPath),
        headers:
          token === undefined ? undefined : { authorization: `Bearer ${token}` },
      });
      const onError = (error: Error) => reject(error);
      client.once('error', onError);
      client.once('open', () => {
        client.off('error', onError);
        resolve(client);
      });
    });
    return new UnixTransport(socket);
  }

  messages(): AsyncIterable<Uint8Array> { return this.incoming; }

  send(message: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Unix transport is closed.'));
    return new Promise((resolve, reject) => {
      this.socket.send(message, (error?: Error | null) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.incoming.end();
    if (this.socket.readyState === WebSocket.CLOSED) return;
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
      this.socket.close(1000, 'client closed');
    });
  }
}
