import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import { createEntityId } from '../../domain/ids.js';
import { AppServerError } from '../../protocol/errors.js';

import type { AppServerTransport } from './transport.js';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface StdioTransportOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly connectionId?: string;
  readonly maxMessageBytes?: number;
}

/** stdout 每行只写一条 JSON-RPC；日志必须由上层写 stderr。 */
export class StdioTransport implements AppServerTransport {
  readonly kind = 'stdio' as const;
  readonly connectionId: string;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly maxMessageBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: StdioTransportOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.connectionId = options.connectionId ?? createEntityId('watch');
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  }

  async *messages(): AsyncIterable<Uint8Array> {
    let buffered = Buffer.alloc(0);
    for await (const chunk of this.input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered = Buffer.concat([buffered, bytes]);
      if (buffered.byteLength > this.maxMessageBytes && !buffered.includes(10)) {
        throw new AppServerError({
          type: 'invalidRequest',
          message: `stdio JSON-RPC line exceeds ${this.maxMessageBytes} bytes.`,
        });
      }
      let newline = buffered.indexOf(10);
      while (newline !== -1) {
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (line.byteLength > this.maxMessageBytes) {
          throw new AppServerError({
            type: 'invalidRequest',
            message: `stdio JSON-RPC line exceeds ${this.maxMessageBytes} bytes.`,
          });
        }
        if (line.byteLength > 0) yield line;
        newline = buffered.indexOf(10);
      }
    }
    if (buffered.byteLength > 0) {
      throw new AppServerError({
        type: 'parseError',
        message: 'stdio ended with an incomplete JSON-RPC line.',
      });
    }
  }

  send(message: Uint8Array): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('stdio transport is closed.'));
    }
    const operation = this.writeQueue.then(async () => {
      if (message.byteLength > this.maxMessageBytes) {
        throw new AppServerError({
          type: 'serverOverloaded',
          message: 'Outgoing JSON-RPC message exceeds the transport limit.',
        });
      }
      if (!this.output.write(Buffer.concat([Buffer.from(message), Buffer.from('\n')]))) {
        await once(this.output, 'drain');
      }
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeQueue;
    this.input.destroy();
    if (this.output !== process.stdout) this.output.end();
  }
}
