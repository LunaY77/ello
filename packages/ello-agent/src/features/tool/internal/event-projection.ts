/**
 * 本文件负责 tool feature 的“event-projection”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  EngineEvent,
  DeferredApprovalItem,
} from '../../agent/engine/index.js';

import { logicalToolCall } from './meta-tools.js';

/**
 * 将内核事件中的 call_tool wrapper 解包，供 TUI、录制器和观察者消费。
 *
 * Args:
 * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
 *
 * Returns:
 * - 返回 `projectToolEvent` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectToolEvent(event: EngineEvent): EngineEvent {
  if (event.type === 'tool.started') {
    const logical = logicalToolCall({ name: event.name, input: event.input });
    return { ...event, name: logical.name, input: logical.input };
  }
  if (event.type === 'tool.approval_requested') {
    const logical = logicalToolCall({
      name: event.request.name,
      input: event.request.input,
    });
    return {
      ...event,
      request: {
        ...event.request,
        name: logical.name,
        input: logical.input,
      },
    };
  }
  if (event.type === 'approval.required') {
    return { ...event, item: projectApprovalItem(event.item) };
  }
  return event;
}

/**
 * 执行 工具 `event-projection` 模块 定义的 `projectApprovalItem` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `item`: 要由 `projectApprovalItem` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `projectApprovalItem` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectApprovalItem(
  item: DeferredApprovalItem,
): DeferredApprovalItem {
  // deferred item 仍保留 wrapper 供 resume 使用，这里只生成展示层副本。
  if (item.kind !== 'approval' || item.toolName !== 'call_tool') {
    return item;
  }
  const logical = logicalToolCall({
    name: item.toolName,
    input: item.input,
  });
  if (item.metadata?.proxiedTool !== logical.name) {
    throw new Error(
      `Approval proxy metadata does not match target '${logical.name}'.`,
    );
  }
  return {
    ...item,
    toolName: logical.name,
    input: logical.input,
  };
}
