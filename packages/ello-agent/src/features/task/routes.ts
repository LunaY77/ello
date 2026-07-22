/**
 * 本文件负责 task feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { invalidParams } from '../../protocol/errors.js';
import { jsonRecord } from '../../protocol/json-value.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import { page } from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';

import type { TaskBoardStore } from './store.js';
import type { Task } from './types.js';

type TaskMethod =
  | 'task/list'
  | 'task/get'
  | 'task/create'
  | 'task/update'
  | 'task/delete'
  | 'task/claim'
  | 'task/reset';

interface TaskContext {
  readonly store: TaskBoardStore;
}

/** Task handler 把 storage snake_case 状态集中映射为 wire camelCase 状态。 */
const taskHandlers = {
  'task/list': (context, params) => {
    const selectedBoard =
      params.boardId === undefined
        ? context.store.getOrCreateBoard({
            type: 'global',
            name: 'default',
          })
        : board(context, params.boardId);
    const tasks = context.store
      .listTasks(selectedBoard.id)
      .filter(
        (task) =>
          params.status === undefined ||
          protocolTaskStatus(task.status) === params.status,
      );
    return page(tasks.map(protocolTask), params.cursor, params.limit);
  },
  'task/get': (context, params) => ({
    task: protocolTask(requireTask(context, params.id)),
  }),
  'task/create': (context, params) => {
    const selectedBoard = board(context, params.boardId);
    const task = context.store.createTask(selectedBoard.id, {
      subject: params.subject,
      description: params.description,
      ...(params.activeForm === undefined
        ? {}
        : { activeForm: params.activeForm }),
      ...(params.owner === undefined ? {} : { owner: params.owner }),
      blockedBy: params.blockedBy,
      metadata: jsonRecord(params.metadata),
    });
    return { task: protocolTask(task) };
  },
  'task/update': (context, params) => {
    const current = requireTask(context, params.id);
    const blockedBy = new Set(current.blockedBy.map((task) => task.id));
    for (const id of params.addBlockedBy ?? []) blockedBy.add(id);
    for (const id of params.removeBlockedBy ?? []) blockedBy.delete(id);
    const task = context.store.updateTask(current.boardId, current.id, {
      ...(params.subject === undefined ? {} : { subject: params.subject }),
      ...(params.description === undefined
        ? {}
        : { description: params.description }),
      ...(params.activeForm === undefined
        ? {}
        : { activeForm: params.activeForm }),
      ...(params.status === undefined
        ? {}
        : { status: storageTaskStatus(params.status) }),
      ...(params.owner === undefined ? {} : { owner: params.owner }),
      blockedBy: [...blockedBy],
      ...(params.metadata === undefined
        ? {}
        : { metadata: jsonRecord(params.metadata) }),
    });
    return { task: protocolTask(task) };
  },
  'task/delete': (context, params) => {
    const current = requireTask(context, params.id);
    if (!context.store.deleteTask(current.boardId, current.id)) {
      throw invalidParams(`Task ${params.id} was not deleted.`);
    }
    return { ok: true };
  },
  'task/claim': (context, params) => {
    const current = requireTask(context, params.id);
    const result = context.store.claimTask(
      current.boardId,
      current.id,
      params.owner,
    );
    if (!result.ok) throw invalidParams(result.reason);
    return { task: protocolTask(result.task) };
  },
  'task/reset': (context, params) => {
    if (!params.force) {
      throw invalidParams('task/reset requires force=true.');
    }
    const selectedBoard = context.store.getBoardById(params.boardId);
    if (selectedBoard === null) {
      throw invalidParams(`Unknown task board ${params.boardId}.`);
    }
    context.store.resetBoard(selectedBoard.id);
    return { ok: true };
  },
} satisfies FeatureHandlerMap<TaskContext, TaskMethod>;

function board(context: TaskContext, boardId: string) {
  const repository = context.store;
  return (
    repository.getBoardById(boardId) ??
    repository.getOrCreateBoard({ type: 'global', name: boardId })
  );
}

function requireTask(context: TaskContext, id: string): Task {
  const task = context.store.findTaskById(id);
  if (task === null) throw invalidParams(`Unknown task ${id}.`);
  return task;
}

function protocolTask(task: Task) {
  return {
    id: task.id,
    boardId: task.boardId,
    subject: task.subject,
    description: task.description,
    ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
    status: protocolTaskStatus(task.status),
    owner: task.owner ?? null,
    blockedBy: task.blockedBy.map((blocked) => blocked.id),
    metadata: jsonRecord(task.metadata),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function protocolTaskStatus(status: Task['status']) {
  return status === 'in_progress' ? ('inProgress' as const) : status;
}

function storageTaskStatus(
  status: 'pending' | 'inProgress' | 'completed' | 'cancelled',
) {
  return status === 'inProgress' ? ('in_progress' as const) : status;
}

/**
 * 构造 Task route 适配 模块 中的 `createTaskRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `store`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 *
 * Returns:
 * - 返回 `createTaskRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Task route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createTaskRoutes(
  store: TaskBoardStore,
): RpcRouteFragment<TaskMethod> {
  const bind = <M extends TaskMethod>(method: M) =>
    bindFeatureRoute(taskHandlers, () => ({ store }), method);
  return {
    'task/list': bind('task/list'),
    'task/get': bind('task/get'),
    'task/create': bind('task/create'),
    'task/update': bind('task/update'),
    'task/delete': bind('task/delete'),
    'task/claim': bind('task/claim'),
    'task/reset': bind('task/reset'),
  };
}
