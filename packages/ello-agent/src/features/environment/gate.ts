/**
 * Environment generation 级共享执行 gate。
 *
 * 同一 Environment 的不同 Handle 共用读写锁；只读操作可并发，写入与安全性未知的
 * 操作独占。等待和拿锁后执行都观察取消信号。
 */
import type { EnvironmentHandle } from './contracts.js';

interface GateWaiter {
  readonly mode: 'shared' | 'exclusive';
  /** 在取得 gate 后把幂等 release 回调交给等待方。 */
  readonly resolve: (release: () => void) => void;
  /** 在取消或 gate 失败时结束等待并保留原始错误。 */
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  /** 从 AbortSignal 移除等待项时使用的监听回调。 */
  abortListener?: () => void;
}

const environmentGates = new Map<string, EnvironmentExecutionGate>();

/** 返回当前 Environment generation 共用的执行 gate。 */
export function environmentExecutionGateFor(
  environment: EnvironmentHandle,
): EnvironmentExecutionGate {
  const key = `${environment.environmentRef}:${environment.generation}`;
  const existing = environmentGates.get(key);
  if (existing !== undefined) return existing;
  const created = new EnvironmentExecutionGate();
  environmentGates.set(key, created);
  return created;
}

/** 支持取消和 writer fairness 的异步读写 gate。 */
export class EnvironmentExecutionGate {
  private activeReaders = 0;
  private writerActive = false;
  private readonly queue: GateWaiter[] = [];

  /** 以共享模式执行确认安全的只读操作。 */
  async runShared<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.run('shared', operation, signal);
  }

  /** 以独占模式执行写操作或安全性未知的操作。 */
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
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        waiter.abortListener = () => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(signal.reason ?? new Error('Environment execution aborted.'));
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
