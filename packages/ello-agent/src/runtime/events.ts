import type { ModelMessage } from 'ai';

import type { AgentStreamEvent, TextDelta, ToolCallDelta } from '../streaming/index.js';

export function agentStart(runId: string): AgentStreamEvent {
  return { type: 'agent_start', runId };
}

export function turnStart(runId: string, turnIndex: number): AgentStreamEvent {
  return { type: 'turn_start', runId, turnIndex };
}

export function messageStart(message: ModelMessage): AgentStreamEvent {
  return { type: 'message_start', message };
}

export function messageDelta(
  delta: TextDelta | ToolCallDelta,
  partial: ModelMessage,
): AgentStreamEvent {
  return { type: 'message_delta', delta, partial };
}

export function messageEnd(message: ModelMessage): AgentStreamEvent {
  return { type: 'message_end', message };
}

export function toolExecutionStart(options: {
  toolCallId: string;
  toolName: string;
  args: unknown;
}): AgentStreamEvent {
  return { type: 'tool_execution_start', ...options };
}

export function toolExecutionEnd(options: {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}): AgentStreamEvent {
  return { type: 'tool_execution_end', ...options };
}

export function turnEnd(
  message: ModelMessage,
  toolResults: ModelMessage[],
): AgentStreamEvent {
  return { type: 'turn_end', message, toolResults };
}

export function agentEnd(messages: ModelMessage[]): AgentStreamEvent {
  return { type: 'agent_end', messages };
}

export function agentError(
  error: Error,
  partialMessages: ModelMessage[],
): AgentStreamEvent {
  return { type: 'agent_error', error, partialMessages };
}
