import type { AgentMessage } from '@ello/agent';

import {
  UserInputRequestSchema,
  type PendingUserInput,
  type UserInputResolution,
} from './schema.js';
import { REQUEST_USER_INPUT_TOOL_NAME } from './tool.js';

/** 从 raw active transcript 恢复唯一未配对的问询调用。 */
export function recoverPendingUserInput(
  messages: readonly AgentMessage[],
  sessionId: string,
): PendingUserInput | null {
  const calls = new Map<string, unknown>();
  const results = new Set<string>();
  for (const message of messages) {
    const content = (message as { readonly content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      const id = readString(part.toolCallId ?? part.id);
      if (id === undefined) continue;
      if (
        message.role === 'assistant' &&
        part.type === 'tool-call' &&
        readString(part.toolName ?? part.name) === REQUEST_USER_INPUT_TOOL_NAME
      ) {
        if (calls.has(id)) {
          throw new Error(
            `Session ${sessionId} contains duplicate request_user_input call ${id}.`,
          );
        }
        calls.set(id, part.input ?? part.args);
      } else if (message.role === 'tool' && part.type === 'tool-result') {
        results.add(id);
      }
    }
  }
  const pending = [...calls].filter(([id]) => !results.has(id));
  if (pending.length > 1) {
    throw new Error(
      `Session ${sessionId} contains multiple pending user input calls: ${pending.map(([id]) => id).join(', ')}.`,
    );
  }
  const item = pending[0];
  if (item === undefined) return null;
  try {
    return {
      toolCallId: item[0],
      request: UserInputRequestSchema.parse(item[1]),
    };
  } catch (error) {
    throw new Error(
      `Session ${sessionId} contains invalid pending user input ${item[0]}.`,
      { cause: error },
    );
  }
}

export function summarizeUserInputResolution(
  resolution: UserInputResolution,
): string {
  if (resolution.status === 'denied') return 'Denied';
  if (resolution.status === 'chat') return 'Chat about this';
  return resolution.answers
    .map(
      (answer) =>
        `${answer.questionId}: ${answer.selected
          .map((selection) =>
            selection === 'Other' ? (answer.otherText ?? selection) : selection,
          )
          .join(', ')}`,
    )
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
