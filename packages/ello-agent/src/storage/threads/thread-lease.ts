import { mkdir, open, readFile, rm } from 'node:fs/promises';

import { AppServerError } from '../../protocol/errors.js';
import { threadLeasePath, threadLocksDir } from '../paths.js';

export interface ThreadLease {
  readonly threadId: string;
  release(): Promise<void>;
}

/**
 * lock file 防止两个 Server 同时写同一 thread。仅在确认原 pid 不存在时回收死锁。
 */
export class ThreadLeaseStore {
  constructor(private readonly root: string) {}

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
        message: `Thread ${threadId} is owned by process ${owner.pid}.`,
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
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
