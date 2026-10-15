import { AsyncByteQueue } from './async-byte-queue.js';

const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** stdio 与 Unix socket 共用严格 JSONL framing。 */
export class JsonlFramer {
  readonly messages = new AsyncByteQueue();
  private buffered = Buffer.alloc(0);
  private sourceEnded = false;
  private failed = false;
  private backpressured = false;

  constructor(
    private readonly maxBytes = DEFAULT_MAX_MESSAGE_BYTES,
    private readonly onBackpressure: (backpressured: boolean) => void = () =>
      undefined,
  ) {
    this.messages.onCapacityAvailable(() => this.drainBuffered());
  }

  push(chunk: Uint8Array): void {
    if (this.sourceEnded || this.failed) return;
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    if (
      this.buffered.byteLength > this.maxBytes &&
      !this.buffered.includes(10)
    ) {
      this.fail(new Error(`JSON-RPC line exceeds ${this.maxBytes} bytes.`));
      return;
    }
    this.drainBuffered();
  }

  private drainBuffered(): void {
    if (this.failed) return;
    let newline = this.buffered.indexOf(10);
    while (newline !== -1) {
      const line = this.buffered.subarray(0, newline);
      if (line.byteLength > this.maxBytes) {
        this.fail(new Error(`JSON-RPC line exceeds ${this.maxBytes} bytes.`));
        return;
      }
      if (line.byteLength > 0 && !this.messages.tryPush(line)) {
        this.setBackpressured(true);
        return;
      }
      this.buffered = this.buffered.subarray(newline + 1);
      newline = this.buffered.indexOf(10);
    }
    this.setBackpressured(false);
    if (!this.sourceEnded) return;
    if (this.buffered.byteLength > 0) {
      this.fail(new Error('Transport ended with an incomplete JSON-RPC line.'));
      return;
    }
    this.messages.end();
  }

  end(): void {
    if (this.sourceEnded || this.failed) return;
    this.sourceEnded = true;
    this.drainBuffered();
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.buffered = Buffer.alloc(0);
    this.messages.fail(error);
  }

  encode(message: Uint8Array): Buffer {
    if (message.byteLength > this.maxBytes) {
      throw new Error(`JSON-RPC message exceeds ${this.maxBytes} bytes.`);
    }
    return Buffer.concat([Buffer.from(message), Buffer.from('\n')]);
  }

  private setBackpressured(backpressured: boolean): void {
    if (this.backpressured === backpressured) return;
    this.backpressured = backpressured;
    this.onBackpressure(backpressured);
  }
}
