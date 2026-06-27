import { randomUUID } from 'node:crypto';

import { z } from 'zod';

export const TaskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskRecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  activeForm: z.string(),
  status: TaskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  outputFile: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

/**
 * 独立于 agent runtime 跟踪任务记录，让 UI 状态可跨会话恢复和分支操作保留。
 */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(initial: TaskRecord[] = []) {
    for (const task of initial) {
      this.tasks.set(task.id, TaskRecordSchema.parse(task));
    }
  }

  /**
   * 根据用户目标或 agent 子任务创建一个待处理任务。
   */
  create(content: string, options: { activeForm?: string; outputFile?: string | null } = {}): TaskRecord {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: `task_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      content,
      activeForm: options.activeForm ?? content,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      outputFile: options.outputFile ?? null,
      error: null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /**
   * 更新可变任务字段，并刷新更新时间。
   */
  update(id: string, patch: Partial<Pick<TaskRecord, 'content' | 'activeForm' | 'status' | 'outputFile' | 'error'>>): TaskRecord {
    const current = this.get(id);
    const next = TaskRecordSchema.parse({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    this.tasks.set(id, next);
    return next;
  }

  /**
   * 按 id 读取任务；调用方引用过期任务 id 时快速失败。
   */
  get(id: string): TaskRecord {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new Error(`Task not found: ${id}`);
    }
    return task;
  }

  /**
   * 按创建顺序返回任务，保证 CLI/TUI 渲染稳定。
   */
  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 返回脱离内部状态的任务对象，避免消费者直接修改内部数据。
   */
  snapshot(): TaskRecord[] {
    return this.list().map((task) => ({ ...task }));
  }
}

/**
 * 将任务记录格式化为紧凑的 CLI 表格。
 */
export function formatTasks(tasks: TaskRecord[]): string {
  if (tasks.length === 0) {
    return 'No tasks.';
  }
  return tasks
    .map((task) => `${task.id}\t${task.status}\t${task.activeForm}`)
    .join('\n');
}
