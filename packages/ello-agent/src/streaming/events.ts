import type { ModelMessage } from 'ai';

/** 文本增量。 */
export interface TextDelta {
  type: 'text';
  text: string;
}

/** 工具调用参数增量。 */
export interface ToolCallDelta {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  argsDelta: string;
}

/** TS-first agent 事件协议。 */
export type AgentStreamEvent =
  | { type: 'agent_start'; runId: string }
  | { type: 'turn_start'; runId: string; turnIndex: number }
  | { type: 'message_start'; message: ModelMessage }
  | {
      type: 'message_delta';
      delta: TextDelta | ToolCallDelta;
      partial: ModelMessage;
    }
  | { type: 'message_end'; message: ModelMessage }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: 'turn_end'; message: ModelMessage; toolResults: ModelMessage[] }
  | { type: 'agent_end'; messages: ModelMessage[] }
  | { type: 'error'; error: Error; partialMessages: ModelMessage[] };
