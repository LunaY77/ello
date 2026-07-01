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
  /** 运行开始。 */
  | { type: 'run.started'; runId: string }
  /** 单个回合开始。 */
  | { type: 'turn.started'; runId: string; turnIndex: number }
  /** 某队列被抽空，携带本次抽空的条数。 */
  | { type: 'queue.drained'; runId: string; queue: string; count: number }
  /** 一条助手消息开始。 */
  | { type: 'message.started'; messageId: string; role: 'assistant' }
  /** 助手消息的文本增量。 */
  | { type: 'message.delta'; messageId: string; text: string }
  /** 工具开始执行，携带入参。 */
  | { type: 'tool.started'; toolCallId: string; name: string; input: unknown }
  /** 工具触发审批请求。 */
  | { type: 'tool.approval_requested'; request: AgentApprovalRequest }
  /** 运行因等待审批而挂起，携带待审批项（供 `resume`）。 */
  | { type: 'approval.required'; runId: string; item: DeferredApprovalItem }
  /** 工具执行完成，携带输出。 */
  | { type: 'tool.completed'; toolCallId: string; output: unknown }
  /** 工具执行失败，携带错误。 */
  | { type: 'tool.failed'; toolCallId: string; error: AgentError }
  /** 单个回合结束。 */
  | { type: 'turn.completed'; turnIndex: number }
  /** 运行被中断，携带中断时的消息现场。 */
  | { type: 'run.interrupted'; runId: string; messages: AgentMessage[] }
  /** 运行成功完成，携带最终结果。 */
  | { type: 'run.completed'; result: AgentRunResult }
  /** 运行失败，携带错误与已产出的部分消息。 */
  | {
      type: 'run.failed';
      error: AgentError;
      partialMessages: AgentMessage[];
    };
