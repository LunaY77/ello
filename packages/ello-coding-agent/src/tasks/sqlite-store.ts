import { eq, and, asc } from 'drizzle-orm';

import {
  openGlobalCodingDatabaseSync,
  transaction,
  type CodingDatabase,
} from '../storage/database.js';
import { taskCounters, taskLinks, tasks } from '../storage/schema.js';

import type { Task, TaskStore, TaskStatus } from './types.js';

/**
 * SQLite 任务存储。
 *
 * `TaskService` 的公开行为保持不变，但主源从 `~/.ello/tasks/*.json` 切到
 * `~/.ello/state.sqlite`。短数字 ID 由 `task_counters` 在事务中递增，避免目录
 * `.lock` 和并发写文件造成的竞态。
 */
export class SqliteTaskStore implements TaskStore {
  constructor(
    private readonly listId = 'default',
    private readonly db: CodingDatabase = openGlobalCodingDatabaseSync(),
  ) {}

  async nextId(): Promise<string> {
    return transaction(this.db, () => {
      const current = this.db
        .select()
        .from(taskCounters)
        .where(eq(taskCounters.listId, this.listId))
        .get();
      const next = (current?.nextId ?? 0) + 1;
      this.db
        .insert(taskCounters)
        .values({ listId: this.listId, nextId: next })
        .onConflictDoUpdate({
          target: taskCounters.listId,
          set: { nextId: next },
        })
        .run();
      return String(next);
    });
  }

  async list(): Promise<readonly Task[]> {
    const rows = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.listId, this.listId))
      .orderBy(asc(tasks.id))
      .all();
    return rows.map((row) => this.toTask(row));
  }

  async get(id: string): Promise<Task | null> {
    const row = this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.listId, this.listId), eq(tasks.id, id)))
      .get();
    return row === undefined ? null : this.toTask(row);
  }

  async save(task: Task): Promise<Task> {
    const now = new Date().toISOString();
    transaction(this.db, () => {
      this.db
        .insert(tasks)
        .values({
          id: task.id,
          listId: this.listId,
          subject: task.subject,
          description: task.description,
          activeForm: task.activeForm ?? null,
          status: task.status,
          owner: task.owner ?? null,
          metadata: JSON.stringify(task.metadata),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        })
        .onConflictDoUpdate({
          target: tasks.id,
          set: {
            subject: task.subject,
            description: task.description,
            activeForm: task.activeForm ?? null,
            status: task.status,
            owner: task.owner ?? null,
            metadata: JSON.stringify(task.metadata),
            updatedAt: task.updatedAt,
          },
        })
        .run();
      this.db.delete(taskLinks).where(eq(taskLinks.taskId, task.id)).run();
      for (const target of task.blocks) {
        this.insertLink(task.id, 'blocks', target, now);
      }
      for (const target of task.blockedBy) {
        this.insertLink(task.id, 'blocked_by', target, now);
      }
    });
    return task;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (existing === null) {
      return false;
    }
    transaction(this.db, () => {
      this.db.delete(taskLinks).where(eq(taskLinks.taskId, id)).run();
      this.db.delete(taskLinks).where(eq(taskLinks.targetTaskId, id)).run();
      this.db.delete(tasks).where(eq(tasks.id, id)).run();
    });
    return true;
  }

  async reset(): Promise<void> {
    transaction(this.db, () => {
      const ids = this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.listId, this.listId))
        .all()
        .map((row) => row.id);
      for (const id of ids) {
        this.db.delete(taskLinks).where(eq(taskLinks.taskId, id)).run();
        this.db.delete(taskLinks).where(eq(taskLinks.targetTaskId, id)).run();
        this.db.delete(tasks).where(eq(tasks.id, id)).run();
      }
      this.db
        .insert(taskCounters)
        .values({ listId: this.listId, nextId: 0 })
        .onConflictDoUpdate({
          target: taskCounters.listId,
          set: { nextId: 0 },
        })
        .run();
    });
  }

  private insertLink(
    taskId: string,
    relation: 'blocks' | 'blocked_by',
    targetTaskId: string,
    createdAt: string,
  ): void {
    this.db
      .insert(taskLinks)
      .values({ taskId, relation, targetTaskId, createdAt })
      .onConflictDoNothing()
      .run();
  }

  private toTask(row: typeof tasks.$inferSelect): Task {
    const links = this.db
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.taskId, row.id))
      .all();
    return stripUndefinedOptionals({
      id: row.id,
      subject: row.subject,
      description: row.description,
      ...(row.activeForm !== null ? { activeForm: row.activeForm } : {}),
      status: row.status as TaskStatus,
      ...(row.owner !== null ? { owner: row.owner } : {}),
      blocks: links
        .filter((link) => link.relation === 'blocks')
        .map((link) => link.targetTaskId),
      blockedBy: links
        .filter((link) => link.relation === 'blocked_by')
        .map((link) => link.targetTaskId),
      metadata: parseMetadata(row.metadata),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}

function parseMetadata(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
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
