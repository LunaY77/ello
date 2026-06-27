import type {
  AgentApprovalRequest,
  DeferredApprovalItem,
  AgentError,
  AgentMessage,
  AgentRunResult,
} from './types.js';

/**
 * 稳定、可渲染、可持久化的 Agent 事件协议。
 *
 * 事件名使用点分层，方便 UI、日志和 JSONL session 直接消费。
 *
 * @example
 * ```ts
 * for await (const event of agent.stream('hello')) {
 *   if (event.type === 'message.delta') {
 *     process.stdout.write(event.text);
 *   }
 * }
 * ```
 */
export type AgentStreamEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'turn.started'; runId: string; turnIndex: number }
  | { type: 'queue.drained'; runId: string; queue: string; count: number }
  | { type: 'message.started'; messageId: string; role: 'assistant' }
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'tool.started'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool.approval_requested'; request: AgentApprovalRequest }
  | { type: 'approval.required'; runId: string; item: DeferredApprovalItem }
  | { type: 'tool.completed'; toolCallId: string; output: unknown }
  | { type: 'tool.failed'; toolCallId: string; error: AgentError }
  | { type: 'turn.completed'; turnIndex: number }
  | { type: 'run.interrupted'; runId: string; messages: AgentMessage[] }
  | { type: 'subagent.started'; runId: string; name: string; parentRunId: string }
  | { type: 'subagent.completed'; runId: string; name: string; result: AgentRunResult }
  | { type: 'subagent.failed'; runId: string; name: string; error: AgentError }
  | { type: 'run.completed'; result: AgentRunResult }
  | {
      type: 'run.failed';
      error: AgentError;
      partialMessages: AgentMessage[];
    };
