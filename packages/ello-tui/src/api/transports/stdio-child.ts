import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

import type { ClientTransport } from '../transport.js';

import { JsonlFramer } from './jsonl-framer.js';

export interface StdioChildTransportOptions {
  readonly entryPath: string;
  readonly root?: string;
  readonly stderr?: NodeJS.WritableStream;
  readonly shutdownTimeoutMs?: number;
}

/** 本地 Client 唯一启动链：spawn 独立 server-entry，再只通过 stdio JSONL 通信。 */
export class StdioChildTransport implements ClientTransport {
  readonly kind = 'stdio' as const;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly framer = new JsonlFramer();
  private readonly shutdownTimeoutMs: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: StdioChildTransportOptions) {
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 3_000;
    this.child = spawn(
      process.execPath,
      [
        options.entryPath,
        '--listen',
        'stdio://',
        ...(options.root === undefined ? [] : ['--root', options.root]),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stdout.on('data', (chunk: Buffer) => this.framer.push(chunk));
    this.child.stdout.once('end', () => this.framer.end());
    this.child.once('error', (error) => this.framer.fail(error));
    this.child.once('exit', (code, signal) => {
      if (!this.closed && code !== 0) {
        this.framer.fail(
          new Error(
            `ello-agent exited with code ${String(code)} (${String(signal)}).`,
          ),
        );
      } else {
        this.framer.end();
      }
    });
    const stderr = new LocalChildStderrRouter(options.stderr ?? process.stderr);
    this.child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    this.child.stderr.once('end', () => stderr.end());
  }

  messages(): AsyncIterable<Uint8Array> {
    return this.framer.messages;
  }

  send(message: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('stdio child is closed.'));
    const bytes = this.framer.encode(message);
    const operation = this.writeQueue.then(async () => {
      if (!this.child.stdin.write(bytes)) await once(this.child.stdin, 'drain');
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
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, 'exit').then(() => true);
    const timeout = new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
      timer.unref();
    });
    if (await Promise.race([exited, timeout])) return;
    this.child.kill('SIGTERM');
    const terminated = await Promise.race([exited, timeout]);
    if (!terminated) this.child.kill('SIGKILL');
  }
}

/** 本地子进程的正常生命周期由 TUI 自己管理，只把诊断信息交给用户。 */
export class LocalChildStderrRouter {
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';

  constructor(private readonly target: NodeJS.WritableStream) {}

  push(chunk: Buffer): void {
    this.buffered += this.decoder.write(chunk);
    this.flushLines();
  }

  end(): void {
    this.buffered += this.decoder.end();
    if (this.buffered !== '') {
      this.routeLine(this.buffered);
      this.buffered = '';
    }
  }

  private flushLines(): void {
    let newline = this.buffered.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      this.routeLine(line, true);
      newline = this.buffered.indexOf('\n');
    }
  }

  private routeLine(line: string, newline = false): void {
    if (!isLocalLifecycleInfo(line)) {
      this.target.write(`${line}${newline ? '\n' : ''}`);
    }
  }
}

function isLocalLifecycleInfo(line: string): boolean {
  try {
    const value = JSON.parse(line) as unknown;
    return (
      typeof value === 'object' &&
      value !== null &&
      'level' in value &&
      value.level === 'info' &&
      'event' in value &&
      typeof value.event === 'string' &&
      value.event.startsWith('server.')
    );
  } catch {
    return false;
  }
}
