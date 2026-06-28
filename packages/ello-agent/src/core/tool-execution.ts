/**
 * 单回合工具执行的胶水层。
 *
 * 把模型本回合返回的 tool call 交给 {@link RunSession} 的工具调度器执行，
 * 并将调度器产生的回调翻译成对外的 `tool.*` / `approval.required` 运行事件。
 * 该层不直接执行工具，只负责事件转发与审批去重，真正的执行/审批/结果归一化
 * 都在工具调度器内部完成。
 */

import { normalizeAgentError } from '../public/errors.js';
import type { AgentMessage, AgentToolCall } from '../public/types.js';

import type { ModelCallResult } from './model-call.js';
import type { RunSession } from './run-session.js';

/** 一回合工具执行的结果。 */
export interface ToolExecutionResult {
  /** 本回合产生的 tool-result 消息，需追加进会话历史供下一回合模型读取。 */
  readonly messages: AgentMessage[];
  /** 本回合涉及的 tool call（含输出或错误），用于可观测与状态记录。 */
  readonly toolCalls: AgentToolCall[];
  /** 因等待审批而挂起、尚未执行的 tool call 数量；大于 0 表示本 run 需暂停等待批准。 */
  readonly pendingCount: number;
}

/**
 * 执行模型本回合返回的全部 tool call。
 *
 * 若模型未发起任何工具调用则直接返回空结果。否则委托给运行会话的工具调度器，
 * 由调度器统一处理审批判定、执行与结果归一化，本函数只把调度器的各类回调转成
 * 运行事件发射出去。
 */
export async function executeToolCalls(
  run: RunSession,
  assistant: ModelCallResult,
): Promise<ToolExecutionResult> {
  const toolCallsFromModel = assistant.response?.toolCalls ?? [];
  if (toolCallsFromModel.length === 0) {
    return { messages: [], toolCalls: [], pendingCount: 0 };
  }
  const scheduled = await run.toolScheduler.schedule(toolCallsFromModel, {
    onToolStarted: (toolCallId, name, input) =>
      run.events.emit({ type: 'tool.started', toolCallId, name, input }),
    onApprovalRequired: async (item) => {
      // 审批去重：同一 tool call 可能在多次调度中重复触发审批，
      // 只有当它尚未进入 deferred 队列时才入队并对外发一次 `approval.required`，
      // 避免重复挂起同一审批项或重复通知产品层。
      const wasAlreadyPending = run.runControl.deferredQueue
        .snapshot()
        .some(
          (pending) =>
            pending.kind === 'approval' &&
            pending.toolCallId === item.toolCallId,
        );
      if (!wasAlreadyPending) {
        run.runControl.pushDeferred(item);
        await run.events.emit({
          type: 'approval.required',
          runId: run.runId,
          item,
        });
      }
    },
    onToolCompleted: (toolCallId, output) =>
      run.events.emit({ type: 'tool.completed', toolCallId, output }),
    onToolFailed: (toolCallId, error) =>
      run.events.emit({
        type: 'tool.failed',
        toolCallId,
        error: normalizeAgentError(error),
      }),
  });
  return {
    messages: scheduled.messages,
    toolCalls: scheduled.toolCalls,
    pendingCount: scheduled.pending.length,
  };
}
