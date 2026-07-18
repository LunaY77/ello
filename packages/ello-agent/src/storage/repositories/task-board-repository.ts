import { randomUUID } from 'node:crypto';

import { and, asc, eq, or } from 'drizzle-orm';

import { immediateTransaction, type CodingDatabase } from '../database/database.js';
import { taskBoards, taskDependencies, tasks } from '../database/schema.js';
import type {
  ClaimResult,
  CreateTaskInput,
  Task,
  TaskBoard,
  TaskBoardScope,
  TaskRef,
  TaskStatus,
  UpdateTaskInput,
} from '../tasks/types.js';

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'cancelled']);

export class TaskBoardRepository {
  constructor(private readonly db: CodingDatabase) {}

  createBoard(scope: TaskBoardScope): TaskBoard {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      scopeType: scope.type,
      scopeId: scopeId(scope),
      nextSequence: 1,
      createdAt: now,
      archivedAt: null,
    };
    this.db.insert(taskBoards).values(row).run();
    return toBoard(row);
  }

  getBoard(scope: TaskBoardScope): TaskBoard | null {
    const row = this.db
      .select()
      .from(taskBoards)
      .where(
        and(
          eq(taskBoards.scopeType, scope.type),
          eq(taskBoards.scopeId, scopeId(scope)),
        ),
      )
      .get();
    return row === undefined ? null : toBoard(row);
  }

  getOrCreateBoard(scope: TaskBoardScope): TaskBoard {
    return immediateTransaction(this.db, () => {
      const existing = this.getBoard(scope);
      if (existing !== null) return existing;
      this.db
        .insert(taskBoards)
        .values({
          id: randomUUID(),
          scopeType: scope.type,
          scopeId: scopeId(scope),
          nextSequence: 1,
          createdAt: new Date().toISOString(),
          archivedAt: null,
        })
        .onConflictDoNothing()
        .run();
      const board = this.getBoard(scope);
      if (board === null) {
        throw new Error(`Failed to create task board for ${scope.type}.`);
      }
      return board;
    });
  }

  getBoardById(boardId: string): TaskBoard | null {
    const row = this.db
      .select()
      .from(taskBoards)
      .where(eq(taskBoards.id, boardId))
      .get();
    return row === undefined ? null : toBoard(row);
  }

  listTasks(boardId: string): readonly Task[] {
    this.requireBoard(boardId);
    const rows = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.boardId, boardId))
      .orderBy(asc(tasks.sequence))
      .all();
    const dependencies = this.db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.boardId, boardId))
      .all();
    return projectTasks(rows, dependencies);
  }

  getTask(boardId: string, reference: string): Task | null {
    const row = this.findTaskRow(boardId, reference);
    if (row === null) {
      return null;
    }
    const task = this.listTasks(boardId).find((item) => item.id === row.id);
    if (task === undefined) {
      throw new Error(`Task projection is missing row ${row.id}.`);
    }
    return task;
  }

  findTaskById(id: string): Task | null {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row === undefined ? null : this.getTask(row.boardId, row.id);
  }

  createTask(boardId: string, input: CreateTaskInput): Task {
    const taskId = immediateTransaction(this.db, () => {
      const board = this.requireBoard(boardId);
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db
        .insert(tasks)
        .values({
          id,
          boardId,
          sequence: board.nextSequence,
          subject: input.subject,
          description: input.description ?? '',
          activeForm: input.activeForm ?? null,
          status: 'pending',
          owner: input.owner ?? null,
          metadata: JSON.stringify(input.metadata ?? {}),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      this.db
        .update(taskBoards)
        .set({ nextSequence: board.nextSequence + 1 })
        .where(eq(taskBoards.id, boardId))
        .run();
      this.replaceDependencies(boardId, id, input.blocks, input.blockedBy, now);
      return id;
    });
    return this.requireTask(boardId, taskId);
  }

  updateTask(boardId: string, reference: string, input: UpdateTaskInput): Task {
    const taskId = immediateTransaction(this.db, () => {
      const current = this.requireTaskRow(boardId, reference);
      const values: Partial<typeof tasks.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (input.subject !== undefined) values.subject = input.subject;
      if (input.description !== undefined)
        values.description = input.description;
      if (input.activeForm !== undefined) values.activeForm = input.activeForm;
      if (input.status !== undefined) values.status = input.status;
      if (input.owner !== undefined) values.owner = input.owner;
      if (input.metadata !== undefined) {
        values.metadata = JSON.stringify(input.metadata);
      }
      this.db.update(tasks).set(values).where(eq(tasks.id, current.id)).run();
      this.replaceDependencies(
        boardId,
        current.id,
        input.blocks,
        input.blockedBy,
        values.updatedAt!,
      );
      return current.id;
    });
    return this.requireTask(boardId, taskId);
  }

  deleteTask(boardId: string, reference: string): boolean {
    const row = this.findTaskRow(boardId, reference);
    if (row === null) return false;
    this.db.delete(tasks).where(eq(tasks.id, row.id)).run();
    return true;
  }

  claimTask(boardId: string, reference: string, owner: string): ClaimResult {
    return immediateTransaction(this.db, () => {
      const row = this.findTaskRow(boardId, reference);
      if (row === null) {
        return { ok: false, reason: `unknown task: ${reference}` };
      }
      const task = this.requireTask(boardId, row.id);
      if (TERMINAL_STATUSES.has(task.status)) {
        return { ok: false, reason: `task is ${task.status}`, task };
      }
      const blockers = this.incompleteBlockers(boardId, row.id);
      if (blockers.length > 0) {
        return {
          ok: false,
          reason: `task is blocked by ${blockers.map((item) => item.sequence).join(', ')}`,
          task,
        };
      }
      if (task.owner !== undefined && task.owner !== owner) {
        return {
          ok: false,
          reason: `task is already owned by ${task.owner}`,
          task,
        };
      }
      this.db
        .update(tasks)
        .set({
          owner,
          status: 'in_progress',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, row.id))
        .run();
      return { ok: true, task: this.requireTask(boardId, row.id) };
    });
  }

  resetBoard(boardId: string): void {
    immediateTransaction(this.db, () => {
      this.requireBoard(boardId);
      this.db.delete(tasks).where(eq(tasks.boardId, boardId)).run();
      this.db
        .update(taskBoards)
        .set({ nextSequence: 1 })
        .where(eq(taskBoards.id, boardId))
        .run();
    });
  }

  private replaceDependencies(
    boardId: string,
    taskId: string,
    blocks: readonly string[] | undefined,
    blockedBy: readonly string[] | undefined,
    createdAt: string,
  ): void {
    if (blocks !== undefined) {
      this.db
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.boardId, boardId),
            eq(taskDependencies.blockerTaskId, taskId),
          ),
        )
        .run();
      for (const reference of blocks) {
        this.insertDependency(
          boardId,
          taskId,
          this.requireTaskRow(boardId, reference).id,
          createdAt,
        );
      }
    }
    if (blockedBy !== undefined) {
      this.db
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.boardId, boardId),
            eq(taskDependencies.blockedTaskId, taskId),
          ),
        )
        .run();
      for (const reference of blockedBy) {
        this.insertDependency(
          boardId,
          this.requireTaskRow(boardId, reference).id,
          taskId,
          createdAt,
        );
      }
    }
  }

  private insertDependency(
    boardId: string,
    blockerTaskId: string,
    blockedTaskId: string,
    createdAt: string,
  ): void {
    if (blockerTaskId === blockedTaskId) {
      throw new Error('Task cannot depend on itself.');
    }
    this.db
      .insert(taskDependencies)
      .values({ boardId, blockerTaskId, blockedTaskId, createdAt })
      .run();
  }

  private incompleteBlockers(
    boardId: string,
    taskId: string,
  ): readonly TaskRef[] {
    const rows = this.db
      .select({
        id: tasks.id,
        sequence: tasks.sequence,
        subject: tasks.subject,
        status: tasks.status,
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.blockerTaskId, tasks.id))
      .where(
        and(
          eq(taskDependencies.boardId, boardId),
          eq(taskDependencies.blockedTaskId, taskId),
          or(eq(tasks.status, 'pending'), eq(tasks.status, 'in_progress')),
        ),
      )
      .orderBy(asc(tasks.sequence))
      .all();
    return rows.map(toTaskRef);
  }

  private requireBoard(boardId: string): TaskBoard {
    const board = this.getBoardById(boardId);
    if (board === null) throw new Error(`Unknown task board: ${boardId}`);
    return board;
  }

  private requireTask(boardId: string, reference: string): Task {
    const task = this.getTask(boardId, reference);
    if (task === null) throw new Error(`Unknown task: ${reference}`);
    return task;
  }

  private requireTaskRow(boardId: string, reference: string) {
    const row = this.findTaskRow(boardId, reference);
    if (row === null) throw new Error(`Unknown task: ${reference}`);
    return row;
  }

  private findTaskRow(boardId: string, reference: string) {
    const bySequence = /^\d+$/u.test(reference) ? Number(reference) : null;
    const row = this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.boardId, boardId),
          bySequence === null
            ? eq(tasks.id, reference)
            : eq(tasks.sequence, bySequence),
        ),
      )
      .get();
    if (row !== undefined) return row;
    if (bySequence === null) {
      const outside = this.db
        .select({ boardId: tasks.boardId })
        .from(tasks)
        .where(eq(tasks.id, reference))
        .get();
      if (outside !== undefined) {
        throw new Error(`Task ${reference} belongs to another board.`);
      }
    }
    return null;
  }
}

function projectTasks(
  rows: readonly (typeof tasks.$inferSelect)[],
  dependencies: readonly (typeof taskDependencies.$inferSelect)[],
): readonly Task[] {
  const refs = new Map(rows.map((row) => [row.id, toTaskRef(row)]));
  return rows.map((row) => ({
    id: row.id,
    boardId: row.boardId,
    sequence: row.sequence,
    subject: row.subject,
    description: row.description,
    ...(row.activeForm !== null ? { activeForm: row.activeForm } : {}),
    status: parseStatus(row.id, row.status),
    ...(row.owner !== null ? { owner: row.owner } : {}),
    blocks: dependencies
      .filter((edge) => edge.blockerTaskId === row.id)
      .map((edge) => requireRef(refs, edge.blockedTaskId, edge.blockerTaskId)),
    blockedBy: dependencies
      .filter((edge) => edge.blockedTaskId === row.id)
      .map((edge) => requireRef(refs, edge.blockerTaskId, edge.blockedTaskId)),
    metadata: parseMetadata(row.id, row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

function requireRef(
  refs: ReadonlyMap<string, TaskRef>,
  taskId: string,
  relatedTaskId: string,
): TaskRef {
  const ref = refs.get(taskId);
  if (ref === undefined) {
    throw new Error(
      `Invalid task_dependencies row ${relatedTaskId}:${taskId}: referenced task is missing.`,
    );
  }
  return ref;
}

function toTaskRef(row: {
  readonly id: string;
  readonly sequence: number;
  readonly subject: string;
  readonly status: string;
}): TaskRef {
  return {
    id: row.id,
    sequence: row.sequence,
    subject: row.subject,
    status: parseStatus(row.id, row.status),
  };
}

function parseStatus(rowId: string, value: string): TaskStatus {
  if (
    value !== 'pending' &&
    value !== 'in_progress' &&
    value !== 'completed' &&
    value !== 'cancelled'
  ) {
    throw new Error(`Invalid tasks row ${rowId}: unknown status ${value}.`);
  }
  return value;
}

function parseMetadata(rowId: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid tasks row ${rowId}: column metadata is not valid JSON.`,
      { cause: error },
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Invalid tasks row ${rowId}: column metadata must be a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

function toBoard(row: typeof taskBoards.$inferSelect): TaskBoard {
  return {
    id: row.id,
    scope: toScope(row.id, row.scopeType, row.scopeId),
    nextSequence: row.nextSequence,
    createdAt: row.createdAt,
    ...(row.archivedAt !== null ? { archivedAt: row.archivedAt } : {}),
  };
}

function toScope(rowId: string, type: string, id: string): TaskBoardScope {
  if (type === 'session') return { type, sessionId: id };
  if (type === 'global') return { type, name: id };
  throw new Error(
    `Invalid task_boards row ${rowId}: unknown scope_type ${type}.`,
  );
}

function scopeId(scope: TaskBoardScope): string {
  if (scope.type === 'session') return scope.sessionId;
  return scope.name;
}
