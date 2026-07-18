import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { AppServerError } from '../../protocol/errors.js';
import {
  activeThreadsDir,
  archivedThreadLogPath,
  archivedThreadsDir,
  threadLogPath,
} from '../paths.js';

import {
  parseThreadRecord,
  type NewThreadRecord,
  type ThreadRecord,
} from './thread-record.js';

export interface ThreadLogRepositoryOptions {
  readonly root: string;
}

interface WriterState {
  nextSeq: number;
  queue: Promise<void>;
}

export type ThreadRecordListener = (record: ThreadRecord) => void;

/**
 * Thread JSONL 的唯一写入口。每个 thread 有独立 Promise 队列，不同 thread 可并行。
 */
export class ThreadLogRepository {
  private readonly root: string;
  private readonly writers = new Map<string, WriterState>();
  private readonly listeners = new Map<string, ThreadRecordListener>();

  constructor(options: ThreadLogRepositoryOptions) {
    this.root = options.root;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(activeThreadsDir(this.root), { recursive: true }),
      mkdir(archivedThreadsDir(this.root), { recursive: true }),
    ]);
  }

  async create(
    threadId: string,
    record: Extract<NewThreadRecord, { readonly kind: 'thread.created' }>,
  ): Promise<ThreadRecord> {
    await this.initialize();
    const fullRecord = parseThreadRecord(
      {
        ...record,
        schema: 1,
        seq: 1,
        threadId,
        createdAt: new Date().toISOString(),
      },
      `${threadId}:create`,
    );
    const path = threadLogPath(threadId, this.root);
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(fullRecord)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new AppServerError({
          type: 'threadBusy',
          message: `Thread ${threadId} already exists.`,
          cause: error,
        });
      }
      throw error;
    } finally {
      await handle?.close();
    }
    this.writers.set(threadId, { nextSeq: 2, queue: Promise.resolve() });
    return fullRecord;
  }

  append(threadId: string, record: NewThreadRecord): Promise<ThreadRecord> {
    const task = this.appendQueued(threadId, record);
    // 队列必须继续可用；当前调用仍会拿到原始 rejection。
    void task.catch(() => undefined);
    return task;
  }

  /**
   * runtime 订阅同一 JSONL writer 的提交结果，保证 transcript 与领域事件严格按
   * 已落盘 seq 更新 snapshot/SQLite；一个 thread 同时只能有一个 runtime owner。
   */
  subscribe(threadId: string, listener: ThreadRecordListener): () => void {
    if (this.listeners.has(threadId)) {
      throw new Error(`Thread log ${threadId} already has a runtime listener.`);
    }
    this.listeners.set(threadId, listener);
    return () => {
      if (this.listeners.get(threadId) === listener) {
        this.listeners.delete(threadId);
      }
    };
  }

  async read(threadId: string): Promise<readonly ThreadRecord[]> {
    return this.readPath(threadLogPath(threadId, this.root), threadId);
  }

  async readArchived(threadId: string): Promise<readonly ThreadRecord[]> {
    return this.readPath(archivedThreadLogPath(threadId, this.root), threadId);
  }

  async archive(threadId: string): Promise<void> {
    await this.flush(threadId);
    await mkdir(archivedThreadsDir(this.root), { recursive: true });
    await rename(
      threadLogPath(threadId, this.root),
      archivedThreadLogPath(threadId, this.root),
    );
    this.writers.delete(threadId);
  }

  async unarchive(threadId: string): Promise<void> {
    await mkdir(activeThreadsDir(this.root), { recursive: true });
    await rename(
      archivedThreadLogPath(threadId, this.root),
      threadLogPath(threadId, this.root),
    );
  }

  async delete(threadId: string, archived: boolean): Promise<void> {
    await this.flush(threadId);
    await rm(
      archived
        ? archivedThreadLogPath(threadId, this.root)
        : threadLogPath(threadId, this.root),
      { force: false },
    );
    this.writers.delete(threadId);
  }

  async exists(threadId: string, archived = false): Promise<boolean> {
    try {
      await stat(
        archived
          ? archivedThreadLogPath(threadId, this.root)
          : threadLogPath(threadId, this.root),
      );
      return true;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async listThreadIds(archived = false): Promise<readonly string[]> {
    const directory = archived
      ? archivedThreadsDir(this.root)
      : activeThreadsDir(this.root);
    await mkdir(directory, { recursive: true });
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name.slice(0, -'.jsonl'.length))
      .sort();
  }

  async flush(threadId: string): Promise<void> {
    await this.writers.get(threadId)?.queue;
  }

  private async appendQueued(
    threadId: string,
    record: NewThreadRecord,
  ): Promise<ThreadRecord> {
    const writer = await this.writerFor(threadId);
    let resolveResult: (value: ThreadRecord) => void = () => undefined;
    let rejectResult: (reason: unknown) => void = () => undefined;
    const result = new Promise<ThreadRecord>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const operation = writer.queue.then(async () => {
      const fullRecord = parseThreadRecord(
        {
          ...record,
          schema: 1,
          seq: writer.nextSeq,
          threadId,
          createdAt: new Date().toISOString(),
        },
        `${threadId}:${writer.nextSeq}`,
      );
      const handle = await open(threadLogPath(threadId, this.root), 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(fullRecord)}\n`, 'utf8');
        if (requiresFlush(fullRecord)) await handle.sync();
      } finally {
        await handle.close();
      }
      writer.nextSeq += 1;
      this.listeners.get(threadId)?.(fullRecord);
      resolveResult(fullRecord);
    });
    operation.catch(rejectResult);
    writer.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writerFor(threadId: string): Promise<WriterState> {
    const existing = this.writers.get(threadId);
    if (existing !== undefined) return existing;
    const records = await this.read(threadId);
    const writer = {
      nextSeq: (records.at(-1)?.seq ?? 0) + 1,
      queue: Promise.resolve(),
    };
    this.writers.set(threadId, writer);
    return writer;
  }

  private async readPath(
    path: string,
    expectedThreadId: string,
  ): Promise<readonly ThreadRecord[]> {
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new AppServerError({
          type: 'threadNotFound',
          message: `Thread ${expectedThreadId} does not exist.`,
          cause: error,
        });
      }
      throw error;
    }
    if (content === '' || !content.endsWith('\n')) {
      throw corrupt(path, 'file is empty or its final line is incomplete');
    }
    const lines = content.slice(0, -1).split('\n');
    const records: ThreadRecord[] = [];
    for (const [lineIndex, line] of lines.entries()) {
      if (line.trim() === '')
        throw corrupt(path, `line ${lineIndex + 1} is empty`);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw corrupt(path, `line ${lineIndex + 1} is invalid JSON`, error);
      }
      let record: ThreadRecord;
      try {
        record = parseThreadRecord(value, `${path}:${lineIndex + 1}`);
      } catch (error) {
        throw corrupt(path, `line ${lineIndex + 1} has invalid schema`, error);
      }
      const expectedSeq = lineIndex + 1;
      if (record.seq !== expectedSeq) {
        throw corrupt(
          path,
          `line ${expectedSeq} has seq ${record.seq}, expected ${expectedSeq}`,
        );
      }
      if (record.threadId !== expectedThreadId) {
        throw corrupt(
          path,
          `line ${expectedSeq} belongs to thread ${record.threadId}`,
        );
      }
      if (expectedSeq === 1 && record.kind !== 'thread.created') {
        throw corrupt(path, 'first record is not thread.created');
      }
      records.push(record);
    }
    return records;
  }
}

function requiresFlush(record: ThreadRecord): boolean {
  return [
    'turn.completed',
    'turn.interrupted',
    'turn.failed',
    'item.completed',
    'serverRequest.created',
    'serverRequest.resolved',
  ].includes(record.kind);
}

function corrupt(
  path: string,
  reason: string,
  cause?: unknown,
): AppServerError {
  return new AppServerError({
    type: 'storageCorrupt',
    message: `Thread log ${path} is corrupt: ${reason}.`,
    details: { path, reason },
    cause,
  });
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
