import type { TaskRecord } from '@ello/coding-agent';

/**
 * 为任务状态徽标渲染简短计数摘要。
 */
export function countTasks(tasks: TaskRecord[]): string {
  const pending = tasks.filter((task) => task.status === 'pending').length;
  const running = tasks.filter((task) => task.status === 'in_progress').length;
  const done = tasks.filter((task) => task.status === 'completed').length;
  return `${pending}/${running}/${done}`;
}

/**
 * 将任意工具值或 JSON 值渲染为紧凑的单行预览。
 */
export function preview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  try {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch {
    return String(value);
  }
}
