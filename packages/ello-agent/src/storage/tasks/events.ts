import type { Task } from './types.js';

export type TaskEvent =
  | { readonly type: 'task.changed'; readonly task: Task }
  | { readonly type: 'task.deleted'; readonly id: string }
  | { readonly type: 'task.list.changed'; readonly tasks: readonly Task[] }
  | { readonly type: 'task.reset' };

export type TaskEventListener = (event: TaskEvent) => void;

/** 轻量任务事件总线，供 CLI/TUI/后台 job 共享状态变化。 */
export class TaskEventBus {
  private readonly listeners = new Set<TaskEventListener>();

  subscribe(listener: TaskEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: TaskEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
