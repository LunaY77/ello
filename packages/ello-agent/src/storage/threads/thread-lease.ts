/**
 * 本文件负责持久化层的“thread-lease”模块职责。
 *
 * 文件、lease 或 record 状态由显式 store 入口拥有；读取结果在离开边界前完成结构校验。
 * 写入顺序、连续序号和资源释放是持久化不变量，损坏数据与非法状态直接失败。
 */
import { mkdir, open, readFile, rm } from 'node:fs/promises';

import { errnoCode } from '../../infra/filesystem.js';
import { threadLeasePath, threadLocksDir } from '../../infra/paths.js';
import { AppServerError } from '../../protocol/errors.js';

export interface ThreadLease {
  readonly threadId: string;
  release(): Promise<void>;
}

/**
 * lock file 防止两个 Server 同时写同一 thread。仅在确认原 pid 不存在时回收死锁。
 */
export class ThreadLeaseStore {
  /**
   * 创建 `ThreadLeaseStore`，由该实例独占 持久化层的 `thread-lease` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   */
  constructor(private readonly root: string) {}

  /**
   * 执行 持久化层的 `thread-lease` 模块 定义的 `tryAcquire` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-lease` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async tryAcquire(threadId: string): Promise<ThreadLease | undefined> {
    try {
      return await this.acquire(threadId);
    } catch (error) {
      if (error instanceof AppServerError && error.type === 'threadBusy') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * 执行 持久化层的 `thread-lease` 模块 定义的 `acquire` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 持久化层的 `thread-lease` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async acquire(threadId: string): Promise<ThreadLease> {
    const directory = threadLocksDir(this.root);
    const path = threadLeasePath(threadId, this.root);
    await mkdir(directory, { recursive: true });
    try {
      return await this.create(path, threadId);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    const owner = await readLock(path);
    if (processExists(owner.pid)) {
      throw new AppServerError({
        type: 'threadBusy',
        message: `Another Ello session is using this thread (process ${owner.pid}). Close it before resuming the thread.`,
        details: { threadId, pid: owner.pid },
      });
    }
    await rm(path);
    return this.create(path, threadId);
  }

  private async create(path: string, threadId: string): Promise<ThreadLease> {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        'utf8',
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    let released = false;
    return {
      threadId,
      release: async () => {
        if (released) return;
        released = true;
        await rm(path, { force: true });
      },
    };
  }
}

async function readLock(path: string): Promise<{ readonly pid: number }> {
  let value: unknown;
  try {
    value = JSON.parse((await readFile(path, 'utf8')).trim());
  } catch (error) {
    throw new AppServerError({
      type: 'storageCorrupt',
      message: `Thread lock ${path} is invalid.`,
      details: { path },
      cause: error,
    });
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    throw new AppServerError({
      type: 'storageCorrupt',
      message: `Thread lock ${path} has an invalid pid.`,
      details: { path },
    });
  }
  return { pid: value.pid };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ESRCH')) return false;
    if (isNodeError(error, 'EPERM')) return true;
    throw error;
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && errnoCode(error) === code;
}
