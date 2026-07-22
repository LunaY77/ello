/**
 * 本文件负责 task feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { TaskEventBus } from './events.js';
import { createTaskRoutes } from './routes.js';
import { TaskService } from './service.js';
import type { TaskBoardStore } from './store.js';
import type { ClaimResult, Task, TaskBoardScope } from './types.js';

/**
 * 构造 Task 公开入口 模块 中的 `createTaskFeature` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `store`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 *
 * Returns:
 * - 返回 `createTaskFeature` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Task 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createTaskFeature(store: TaskBoardStore) {
  return { routes: createTaskRoutes(store) };
}

export { TaskEventBus } from './events.js';
export { TaskService } from './service.js';
export { createTaskBoardStore, type TaskBoardStore } from './store.js';
export type {
  ClaimResult,
  CreateTaskInput,
  Task,
  TaskBoard,
  TaskBoardScope,
  TaskRef,
  TaskStatus,
  UpdateTaskInput,
} from './types.js';
export type { TaskEvent, TaskEventListener } from './events.js';

/**
 * 构造 Task 公开入口 模块 中的 `createTaskService` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 * - `scope`: `createTaskService` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `events`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `createTaskService` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Task 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createTaskService(
  repository: TaskBoardStore,
  scope: TaskBoardScope,
  events = new TaskEventBus(),
): TaskService {
  const board = repository.getOrCreateBoard(scope);
  return new TaskService(repository, board, events);
}

/**
 * 执行 Task 公开入口 模块 定义的 `formatTaskList` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `tasks`: `formatTaskList` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `formatTaskList` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function formatTaskList(tasks: ReadonlyArray<Task>): string {
  if (tasks.length === 0) return 'tasks\t<none>';
  return tasks.map(formatTaskLine).join('\n');
}

/**
 * 执行 Task 公开入口 模块 定义的 `formatTask` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `task`: `formatTask` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `formatTask` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function formatTask(task: Task): string {
  return [
    `id\t${task.sequence}`,
    `uuid\t${task.id}`,
    `status\t${task.status}`,
    `subject\t${task.subject}`,
    `description\t${task.description || '<empty>'}`,
    `owner\t${task.owner ?? '<none>'}`,
    `blocks\t${formatRefs(task.blocks)}`,
    `blockedBy\t${formatRefs(task.blockedBy)}`,
    `createdAt\t${task.createdAt}`,
    `updatedAt\t${task.updatedAt}`,
  ].join('\n');
}

/**
 * 执行 Task 公开入口 模块 定义的 `formatClaimResult` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `result`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
 *
 * Returns:
 * - 返回 `formatClaimResult` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function formatClaimResult(result: ClaimResult): string {
  if (result.ok) {
    return `claimed\t${result.task.sequence}\t${result.task.owner ?? '<none>'}`;
  }
  return `claim failed\t${result.reason}`;
}

function formatTaskLine(task: Task): string {
  const owner = task.owner !== undefined ? ` @${task.owner}` : '';
  const blocked =
    task.blockedBy.length > 0
      ? ` blocked by ${task.blockedBy.map((item) => item.sequence).join(',')}`
      : '';
  return `${task.sequence}\t${task.status}${owner}\t${task.subject}${blocked}`;
}

function formatRefs(refs: Task['blocks']): string {
  return refs.length > 0
    ? refs.map((item) => String(item.sequence)).join(', ')
    : '<none>';
}
