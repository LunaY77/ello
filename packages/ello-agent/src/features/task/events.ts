/**
 * 本文件负责 task feature 的事件联合与发布契约。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { Task } from './types.js';

export type TaskEvent =
  | { readonly type: 'task.changed'; readonly task: Task }
  | { readonly type: 'task.deleted'; readonly id: string }
  | { readonly type: 'task.list.changed'; readonly tasks: readonly Task[] }
  | { readonly type: 'task.reset' };

/**
 * 执行 Task 事件 模块 定义的 `TaskEventListener` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
 *
 * Returns:
 * - Task 事件 模块 的同步状态变更完成后返回，不产生业务结果。
 */
export type TaskEventListener = (event: TaskEvent) => void;

/** 轻量任务事件总线，供 CLI/TUI/后台 job 共享状态变化。 */
export class TaskEventBus {
  private readonly listeners = new Set<TaskEventListener>();

  /**
   * 执行 Task 事件 模块 定义的 `subscribe` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `listener`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
   *
   * Returns:
   * - 返回 `subscribe` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  subscribe(listener: TaskEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 处理 Task 事件 模块 的 `emit` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   *
   * Returns:
   * - Task 事件 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  emit(event: TaskEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
