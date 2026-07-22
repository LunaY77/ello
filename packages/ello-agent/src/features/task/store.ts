/**
 * 本文件负责 task feature 的持久化操作与一致性。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { randomUUID } from 'node:crypto';

import { and, asc, eq, or } from 'drizzle-orm';

import {
  immediateTransaction,
  type CodingDatabase,
} from '../../infra/database/database.js';
import {
  taskBoards,
  taskDependencies,
  tasks,
} from '../../infra/database/schema.js';
import { isRecord } from '../../protocol/json-value.js';

import type {
  ClaimResult,
  CreateTaskInput,
  Task,
  TaskBoard,
  TaskBoardScope,
  TaskRef,
  TaskStatus,
  UpdateTaskInput,
} from './types.js';

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'cancelled']);

/** Task board 的同步持久化操作；所有复合写入在 immediate transaction 内完成。 */
export interface TaskBoardStore {
  /**
   * 构造 Task 持久化 store 模块 中的 `createBoard` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `scope`: `createBoard` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `createBoard` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Task 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  createBoard(scope: TaskBoardScope): TaskBoard;
  /**
   * 读取 Task 持久化 store 模块 的 `getBoard` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `scope`: `getBoard` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  getBoard(scope: TaskBoardScope): TaskBoard | null;
  /**
   * 读取 Task 持久化 store 模块 的 `getOrCreateBoard` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `scope`: `getOrCreateBoard` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `getOrCreateBoard` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  getOrCreateBoard(scope: TaskBoardScope): TaskBoard;
  /**
   * 读取 Task 持久化 store 模块 的 `getBoardById` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `boardId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  getBoardById(boardId: string): TaskBoard | null;
  /**
   * 读取 Task 持久化 store 模块 的 `listTasks` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `boardId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  listTasks(boardId: string): ReadonlyArray<Task>;
  /**
   * 读取 Task 持久化 store 模块 的 `getTask` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `boardId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `reference`: `getTask` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  getTask(boardId: string, reference: string): Task | null;
  /**
   * 读取 Task 持久化 store 模块 的 `findTaskById` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  findTaskById(id: string): Task | null;
  /**
   * 构造 Task 持久化 store 模块 中的 `createTask` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `boardId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `input`: `createTask` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - 返回 `createTask` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Task 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  createTask(boardId: string, input: CreateTaskInput): Task;
  /**
   * 按 Task 持久化 store 模块 的一致性约束执行 `updateTask` 状态变更。
   *
   * Args:
   * - `boardId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `reference`: `updateTask` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `input`: `updateTask` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - 返回 `updateTask` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Task 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  updateTask(boardId: string, reference: string, input: UpdateTaskInput): Task;
  /**
   * 按 Task 持久化 store 模块 的一致性约束执行 `deleteTask` 状态变更。
   *
   * Args:
   * - `boardId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `reference`: `deleteTask` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   *
   * Throws:
   * - 当 Task 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  deleteTask(boardId: string, reference: string): boolean;
  /**
   * 执行 Task 持久化 store 模块 定义的 `claimTask` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `boardId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `reference`: `claimTask` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `owner`: `claimTask` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `claimTask` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  claimTask(boardId: string, reference: string, owner: string): ClaimResult;
  /**
   * 执行 Task 持久化 store 模块 定义的 `resetBoard` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `boardId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Task 持久化 store 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  resetBoard(boardId: string): void;
}

/**
 * 创建闭包持有数据库连接的 Task board store。
 *
 * Args:
 * - `db`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 *
 * Returns:
 * - 返回 `createTaskBoardStore` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Task 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createTaskBoardStore(db: CodingDatabase): TaskBoardStore {
  function createBoard(scope: TaskBoardScope): TaskBoard {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      scopeType: scope.type,
      scopeId: scopeId(scope),
      nextSequence: 1,
      createdAt: now,
      archivedAt: null,
    };
    db.insert(taskBoards).values(row).run();
    return toBoard(row);
  }

  function getBoard(scope: TaskBoardScope): TaskBoard | null {
    const row = db
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

  function getOrCreateBoard(scope: TaskBoardScope): TaskBoard {
    return immediateTransaction(db, () => {
      const existing = getBoard(scope);
      if (existing !== null) return existing;
      db.insert(taskBoards)
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
      const board = getBoard(scope);
      if (board === null) {
        throw new Error(`Failed to create task board for ${scope.type}.`);
      }
      return board;
    });
  }

  function getBoardById(boardId: string): TaskBoard | null {
    const row = db
      .select()
      .from(taskBoards)
      .where(eq(taskBoards.id, boardId))
      .get();
    return row === undefined ? null : toBoard(row);
  }

  function listTasks(boardId: string): readonly Task[] {
    requireBoard(boardId);
    const rows = db
      .select()
      .from(tasks)
      .where(eq(tasks.boardId, boardId))
      .orderBy(asc(tasks.sequence))
      .all();
    const dependencies = db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.boardId, boardId))
      .all();
    return projectTasks(rows, dependencies);
  }

  function getTask(boardId: string, reference: string): Task | null {
    const row = findTaskRow(boardId, reference);
    if (row === null) {
      return null;
    }
    const task = listTasks(boardId).find((item) => item.id === row.id);
    if (task === undefined) {
      throw new Error(`Task projection is missing row ${row.id}.`);
    }
    return task;
  }

  function findTaskById(id: string): Task | null {
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row === undefined ? null : getTask(row.boardId, row.id);
  }

  function createTask(boardId: string, input: CreateTaskInput): Task {
    const taskId = immediateTransaction(db, () => {
      const board = requireBoard(boardId);
      const now = new Date().toISOString();
      const id = randomUUID();
      db.insert(tasks)
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
      db.update(taskBoards)
        .set({ nextSequence: board.nextSequence + 1 })
        .where(eq(taskBoards.id, boardId))
        .run();
      replaceDependencies(boardId, id, input.blocks, input.blockedBy, now);
      return id;
    });
    return requireTask(boardId, taskId);
  }

  function updateTask(
    boardId: string,
    reference: string,
    input: UpdateTaskInput,
  ): Task {
    const taskId = immediateTransaction(db, () => {
      const current = requireTaskRow(boardId, reference);
      const updatedAt = new Date().toISOString();
      const values: Partial<typeof tasks.$inferInsert> = { updatedAt };
      if (input.subject !== undefined) values.subject = input.subject;
      if (input.description !== undefined)
        values.description = input.description;
      if (input.activeForm !== undefined) values.activeForm = input.activeForm;
      if (input.status !== undefined) values.status = input.status;
      if (input.owner !== undefined) values.owner = input.owner;
      if (input.metadata !== undefined) {
        values.metadata = JSON.stringify(input.metadata);
      }
      db.update(tasks).set(values).where(eq(tasks.id, current.id)).run();
      replaceDependencies(
        boardId,
        current.id,
        input.blocks,
        input.blockedBy,
        updatedAt,
      );
      return current.id;
    });
    return requireTask(boardId, taskId);
  }

  function deleteTask(boardId: string, reference: string): boolean {
    const row = findTaskRow(boardId, reference);
    if (row === null) return false;
    db.delete(tasks).where(eq(tasks.id, row.id)).run();
    return true;
  }

  function claimTask(
    boardId: string,
    reference: string,
    owner: string,
  ): ClaimResult {
    return immediateTransaction(db, () => {
      const row = findTaskRow(boardId, reference);
      if (row === null) {
        return { ok: false, reason: `unknown task: ${reference}` };
      }
      const task = requireTask(boardId, row.id);
      if (TERMINAL_STATUSES.has(task.status)) {
        return { ok: false, reason: `task is ${task.status}`, task };
      }
      const blockers = incompleteBlockers(boardId, row.id);
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
      db.update(tasks)
        .set({
          owner,
          status: 'in_progress',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.id, row.id))
        .run();
      return { ok: true, task: requireTask(boardId, row.id) };
    });
  }

  function resetBoard(boardId: string): void {
    immediateTransaction(db, () => {
      requireBoard(boardId);
      db.delete(tasks).where(eq(tasks.boardId, boardId)).run();
      db.update(taskBoards)
        .set({ nextSequence: 1 })
        .where(eq(taskBoards.id, boardId))
        .run();
    });
  }

  function replaceDependencies(
    boardId: string,
    taskId: string,
    blocks: readonly string[] | undefined,
    blockedBy: readonly string[] | undefined,
    createdAt: string,
  ): void {
    if (blocks !== undefined) {
      db.delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.boardId, boardId),
            eq(taskDependencies.blockerTaskId, taskId),
          ),
        )
        .run();
      for (const reference of blocks) {
        insertDependency(
          boardId,
          taskId,
          requireTaskRow(boardId, reference).id,
          createdAt,
        );
      }
    }
    if (blockedBy !== undefined) {
      db.delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.boardId, boardId),
            eq(taskDependencies.blockedTaskId, taskId),
          ),
        )
        .run();
      for (const reference of blockedBy) {
        insertDependency(
          boardId,
          requireTaskRow(boardId, reference).id,
          taskId,
          createdAt,
        );
      }
    }
  }

  function insertDependency(
    boardId: string,
    blockerTaskId: string,
    blockedTaskId: string,
    createdAt: string,
  ): void {
    if (blockerTaskId === blockedTaskId) {
      throw new Error('Task cannot depend on itself.');
    }
    db.insert(taskDependencies)
      .values({ boardId, blockerTaskId, blockedTaskId, createdAt })
      .run();
  }

  function incompleteBlockers(
    boardId: string,
    taskId: string,
  ): readonly TaskRef[] {
    const rows = db
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

  function requireBoard(boardId: string): TaskBoard {
    const board = getBoardById(boardId);
    if (board === null) throw new Error(`Unknown task board: ${boardId}`);
    return board;
  }

  function requireTask(boardId: string, reference: string): Task {
    const task = getTask(boardId, reference);
    if (task === null) throw new Error(`Unknown task: ${reference}`);
    return task;
  }

  function requireTaskRow(boardId: string, reference: string) {
    const row = findTaskRow(boardId, reference);
    if (row === null) throw new Error(`Unknown task: ${reference}`);
    return row;
  }

  function findTaskRow(boardId: string, reference: string) {
    const bySequence = /^\d+$/u.test(reference) ? Number(reference) : null;
    const row = db
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
      const outside = db
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
  return {
    createBoard,
    getBoard,
    getOrCreateBoard,
    getBoardById,
    listTasks,
    getTask,
    findTaskById,
    createTask,
    updateTask,
    deleteTask,
    claimTask,
    resetBoard,
  };
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
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid tasks row ${rowId}: column metadata is not valid JSON.`,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new Error(
      `Invalid tasks row ${rowId}: column metadata must be a JSON object.`,
    );
  }
  return value;
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
