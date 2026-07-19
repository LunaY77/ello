import type { EngineEvent, DeferredApprovalItem } from '../engine/index.js';

import { logicalToolCall } from './meta-tools.js';

/** 将内核事件中的 call_tool wrapper 解包，供 TUI、录制器和观察者消费。 */
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
