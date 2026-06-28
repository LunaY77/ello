import { normalizeAgentError } from '../public/errors.js';
import type { AgentMessage, AgentToolCall } from '../public/types.js';

import type { ModelCallResult } from './model-call.js';
import type { RunSession } from './run-session.js';

export interface ToolExecutionResult {
  readonly messages: AgentMessage[];
  readonly toolCalls: AgentToolCall[];
  readonly pendingCount: number;
}

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
