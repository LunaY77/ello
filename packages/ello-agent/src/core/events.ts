import type { AgentStreamEvent } from '../public/events.js';
import type {
  AgentObserver,
  AgentRunContext,
  AgentToolCall,
  CreateAgentOptions,
} from '../public/types.js';

import type { AgentEventStream } from './stream.js';

/**
 * 事件分发器。
 *
 * 每条事件产生后经此「一处发出、多处投递」：写入 trace、推入对外事件流、
 * 回调所有 observer、转发给环境钩子，并在有会话时落盘持久化。它把事件的
 * 多路扇出集中在一个地方，避免散落在回合循环各处。
 */
export class AgentEventDispatcher {
  /** 按 toolCallId 累积工具调用信息，用于在 completed 时补全 name/input。 */
  private readonly observerToolCalls = new Map<string, AgentToolCall>();

  constructor(
    private readonly config: CreateAgentOptions,
    private readonly stream: AgentEventStream,
    private readonly ctx: AgentRunContext,
  ) {}

  /**
   * 发出一条事件，扇出到各消费方。
   *
   * 顺序为：写 trace → 推对外流 → 投递 observer/环境钩子 → 会话落盘。
   */
  async emit(event: AgentStreamEvent): Promise<void> {
    this.ctx.trace.events.push(event);
    this.stream.emit(event);
    await this.emitObserverEvent(event);
    // 存在会话 id 时把事件追加持久化，供回放/恢复。
    if (this.ctx.sessionId !== undefined) {
      await this.config.session?.appendEvent?.(this.ctx.sessionId, event);
    }
  }

  /** 把事件投递给所有 observer，再转发给环境的 `onEvent` 钩子。 */
  private async emitObserverEvent(event: AgentStreamEvent): Promise<void> {
    for (const observer of this.config.observers ?? []) {
      await emitSingleObserverEvent(
        observer,
        event,
        this.ctx,
        this.observerToolCalls,
      );
    }
    await this.ctx.environment.onEvent?.(event, this.ctx);
  }
}

/**
 * 把单条事件映射到对应的 observer 回调。
 *
 * 按事件类型分派到 `onRunStarted` / `onTurnStarted` / `onToolScheduled` 等；
 * 工具相关事件借助 `toolCalls` 映射跨 started/completed 关联同一次调用，
 * 以便在 completed 时回填 started 阶段记录的 name 与 input。
 */
async function emitSingleObserverEvent(
  observer: AgentObserver,
  event: AgentStreamEvent,
  ctx: AgentRunContext,
  toolCalls: Map<string, AgentToolCall>,
): Promise<void> {
  if (event.type === 'run.started') {
    await observer.onRunStarted?.({ runId: event.runId }, ctx);
    return;
  }
  if (event.type === 'turn.started') {
    await observer.onTurnStarted?.(
      { runId: event.runId, turnIndex: event.turnIndex },
      ctx,
    );
    return;
  }
  if (event.type === 'tool.started') {
    // 记下本次调用的 name/input，completed 时据 toolCallId 回填。
    const call = {
      id: event.toolCallId,
      name: event.name,
      input: event.input,
    };
    toolCalls.set(event.toolCallId, call);
    await observer.onToolScheduled?.(call, ctx);
    return;
  }
  if (event.type === 'approval.required') {
    await observer.onToolApprovalRequired?.(event.item, ctx);
    return;
  }
  if (event.type === 'tool.completed') {
    // 取回 started 阶段的记录补全 name/input；缺失时退化处理。
    const started = toolCalls.get(event.toolCallId);
    const completed = {
      id: event.toolCallId,
      name: started?.name ?? event.toolCallId,
      input: started?.input ?? null,
      output: event.output,
    };
    toolCalls.set(event.toolCallId, completed);
    await observer.onToolCompleted?.(completed, ctx);
    return;
  }
  if (event.type === 'run.completed') {
    await observer.onRunCompleted?.(event.result, ctx);
    return;
  }
  if (event.type === 'run.failed') {
    await observer.onRunFailed?.({ error: event.error }, ctx);
  }
}

/**
 * 释放环境持有的资源。
 *
 * 若环境提供了统一的 `close`，则交由它一并清理；否则逐项关闭资源池、
 * 文件系统、文件句柄与 shell。`files` 与 `fileSystem` 指向同一对象时
 * 只关闭一次，避免重复释放。
 */
export async function closeAgentResources(
  environment: CreateAgentOptions['environment'],
): Promise<void> {
  // 优先走环境自带的统一清理入口。
  if (environment?.close !== undefined) {
    await environment.close();
    return;
  }
  await environment?.resources?.closeAll?.();
  await environment?.fileSystem?.close?.();
  // files 与 fileSystem 若是同一对象，避免重复关闭。
  if (environment?.files !== environment?.fileSystem) {
    await environment?.files?.close?.();
  }
  await environment?.shell?.close?.();
}
