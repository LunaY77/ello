import type { TaskBoardRepository } from '../repositories/task-board-repository.js';

import { TaskEventBus } from './events.js';
import { TaskService } from './service.js';
import type { ClaimResult, Task, TaskBoardScope } from './types.js';

export { TaskEventBus } from './events.js';
export { TaskService } from './service.js';
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

export function createTaskService(
  repository: TaskBoardRepository,
  scope: TaskBoardScope,
  events = new TaskEventBus(),
): TaskService {
  const board = repository.getOrCreateBoard(scope);
  return new TaskService(repository, board, events);
}

export function formatTaskList(tasks: readonly Task[]): string {
  if (tasks.length === 0) return 'tasks\t<none>';
  return tasks.map(formatTaskLine).join('\n');
}

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
