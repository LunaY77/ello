import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { highwatermarkPath, lockPath, taskFilePath } from './paths.js';
import { TaskSchema } from './schema.js';
import type { Task, TaskStore } from './types.js';

/** 基于 JSON 文件的任务存储。 */
export class FileTaskStore implements TaskStore {
  constructor(private readonly baseDir: string) {}

  /** 分配下一个任务 ID，使用锁目录保护高水位递增。 */
  async nextId(): Promise<string> {
    return this.withLock(async () => {
      await mkdir(this.baseDir, { recursive: true });
      const filePath = highwatermarkPath(this.baseDir);
      const current = await readNumber(filePath);
      const next = current + 1;
      await atomicWrite(filePath, `${next}\n`);
      return String(next);
    });
  }

  async list(): Promise<readonly Task[]> {
    await mkdir(this.baseDir, { recursive: true });
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const tasks = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => this.readTask(path.join(this.baseDir, entry.name))),
    );
    return tasks.sort((a, b) => Number(a.id) - Number(b.id));
  }

  async get(id: string): Promise<Task | null> {
    try {
      return await this.readTask(taskFilePath(this.baseDir, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(task: Task): Promise<Task> {
    return this.withLock(async () => {
      await mkdir(this.baseDir, { recursive: true });
      await atomicWrite(
        taskFilePath(this.baseDir, task.id),
        JSON.stringify(task, null, 2),
      );
      return task;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withLock(async () => {
      try {
        await rm(taskFilePath(this.baseDir, id));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    });
  }

  async reset(): Promise<void> {
    await this.withLock(async () => {
      await rm(this.baseDir, { recursive: true, force: true });
      await mkdir(this.baseDir, { recursive: true });
      await atomicWrite(highwatermarkPath(this.baseDir), '0\n');
    });
  }

  private async readTask(filePath: string): Promise<Task> {
    const text = await readFile(filePath, 'utf8');
    return stripUndefinedOptionals(TaskSchema.parse(JSON.parse(text)));
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.baseDir, { recursive: true });
    const lock = lockPath(this.baseDir);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await mkdir(lock);
        try {
          return await fn();
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        await sleep(10);
      }
    }
    throw new Error(`Timed out waiting for task store lock: ${lock}`);
  }
}

function stripUndefinedOptionals(task: Task): Task {
  const next = { ...task };
  if (next.activeForm === undefined) {
    delete next.activeForm;
  }
  if (next.owner === undefined) {
    delete next.owner;
  }
  return next;
}

async function readNumber(filePath: string): Promise<number> {
  try {
    return Number((await readFile(filePath, 'utf8')).trim() || '0');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
