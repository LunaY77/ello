import { AsyncByteQueue } from './async-byte-queue.js';

const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** stdio 与 Unix socket 共用严格 JSONL framing。 */
export class JsonlFramer {
  readonly messages = new AsyncByteQueue();
  private buffered = Buffer.alloc(0);

  constructor(private readonly maxBytes = DEFAULT_MAX_MESSAGE_BYTES) {}

  push(chunk: Uint8Array): void {
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    if (
      this.buffered.byteLength > this.maxBytes &&
      !this.buffered.includes(10)
    ) {
      this.fail(new Error(`JSON-RPC line exceeds ${this.maxBytes} bytes.`));
      return;
    }
    let newline = this.buffered.indexOf(10);
    while (newline !== -1) {
      const line = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      if (line.byteLength > this.maxBytes) {
        this.fail(new Error(`JSON-RPC line exceeds ${this.maxBytes} bytes.`));
        return;
      }
      if (line.byteLength > 0) this.messages.push(line);
      newline = this.buffered.indexOf(10);
    }
  }

  end(): void {
    if (this.buffered.byteLength > 0) {
      this.fail(new Error('Transport ended with an incomplete JSON-RPC line.'));
      return;
    }
    this.messages.end();
  }

  fail(error: unknown): void {
    this.buffered = Buffer.alloc(0);
    this.messages.fail(error);
  }

  encode(message: Uint8Array): Buffer {
    if (message.byteLength > this.maxBytes) {
      throw new Error(`JSON-RPC message exceeds ${this.maxBytes} bytes.`);
    }
    return Buffer.concat([Buffer.from(message), Buffer.from('\n')]);
  }
}
