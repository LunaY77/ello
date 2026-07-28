/**
 * 本文件提供可由多个工具调度器共用的异步读写锁。
 *
 * 使用同一运行环境的工具调用共用一把锁：确认安全的只读工具使用共享锁，
 * 其他工具使用独占锁。已有写操作排队时，后来的读操作不能插队，避免写操作一直得不到执行。
 */

import type { AgentEnvironment } from './contracts.js';

interface GateWaiter {
  readonly mode: 'shared' | 'exclusive';
  /** 拿到锁后用释放函数唤醒调用方。 */
  readonly resolve: (release: () => void) => void;
  /** 等待被取消或加锁失败时通知调用方。 */
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  /** 取消等待时将请求移出队列。 */
  abortListener?: () => void;
}

const environmentGates = new WeakMap<AgentEnvironment, ToolExecutionGate>();

/** 返回当前运行环境共享的工具执行锁。 */
export function toolExecutionGateFor(
  environment: AgentEnvironment,
): ToolExecutionGate {
  const existing = environmentGates.get(environment);
  if (existing !== undefined) return existing;
  const created = new ToolExecutionGate();
  environmentGates.set(environment, created);
  return created;
}

/** 支持取消并按排队顺序分配的进程内异步读写锁。 */
export class ToolExecutionGate {
  private activeReaders = 0;
  private writerActive = false;
  private readonly queue: GateWaiter[] = [];

  /** 以共享锁运行确认安全的只读操作。 */
  async runShared<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.run('shared', operation, signal);
  }

  /** 以独占锁运行写操作或安全性不明确的操作。 */
  async runExclusive<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.run('exclusive', operation, signal);
  }

  private async run<T>(
    mode: GateWaiter['mode'],
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(mode, signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(
    mode: GateWaiter['mode'],
    signal?: AbortSignal,
  ): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: GateWaiter = {
        mode,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal !== undefined) {
        waiter.abortListener = () => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(signal.reason ?? new Error('Tool execution was aborted.'));
          this.dispatch();
        };
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      this.queue.push(waiter);
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.writerActive || this.queue.length === 0) return;
    const first = this.queue[0];
    if (first?.mode === 'exclusive') {
      if (this.activeReaders > 0) return;
      this.queue.shift();
      this.writerActive = true;
      this.grant(first, () => {
        this.writerActive = false;
        this.dispatch();
      });
      return;
    }
    while (this.queue[0]?.mode === 'shared' && !this.writerActive) {
      const reader = this.queue.shift();
      if (reader === undefined) break;
      this.activeReaders += 1;
      this.grant(reader, () => {
        this.activeReaders -= 1;
        this.dispatch();
      });
    }
  }

  private grant(waiter: GateWaiter, release: () => void): void {
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      release();
    });
  }
}
