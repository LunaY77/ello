import { TaskEventBus } from './events.js';
import { TaskService } from './service.js';
import { SqliteTaskStore } from './sqlite-store.js';
import type { ClaimResult, Task } from './types.js';

export { TaskEventBus } from './events.js';
export { FileTaskStore } from './file-store.js';
export { taskListDir } from './paths.js';
export { TaskService } from './service.js';
export { SqliteTaskStore } from './sqlite-store.js';
export type {
  ClaimResult,
  CreateTaskInput,
  Task,
  TaskStatus,
  TaskStore,
  UpdateTaskInput,
} from './types.js';
export type { TaskEvent, TaskEventListener } from './events.js';

/** 创建默认任务服务。 */
export function createTaskService(
  events = new TaskEventBus(),
): TaskService {
  return new TaskService(new SqliteTaskStore(), events);
}

export function formatTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) {
    return 'tasks\t<none>';
  }
  return tasks.map(formatTaskLine).join('\n');
}

export function formatTask(task: Task): string {
  return [
    `id\t${task.id}`,
    `status\t${task.status}`,
    `subject\t${task.subject}`,
    `description\t${task.description || '<empty>'}`,
    `owner\t${task.owner ?? '<none>'}`,
    `blocks\t${task.blocks.join(', ') || '<none>'}`,
    `blockedBy\t${task.blockedBy.join(', ') || '<none>'}`,
    `createdAt\t${task.createdAt}`,
    `updatedAt\t${task.updatedAt}`,
  ].join('\n');
}

export function formatClaimResult(result: ClaimResult): string {
  if (result.ok) {
    return `claimed\t${result.task.id}\t${result.task.owner ?? '<none>'}`;
  }
  return `claim failed\t${result.reason}`;
}

function formatTaskLine(task: Task): string {
  const owner = task.owner !== undefined ? ` @${task.owner}` : '';
  const blocked =
    task.blockedBy.length > 0 ? ` blocked by ${task.blockedBy.join(',')}` : '';
  return `${task.id}\t${task.status}${owner}\t${task.subject}${blocked}`;
}
