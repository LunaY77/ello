import type {
  LanguageModel,
  ModelMessage,
  StepResult,
  streamText,
  TextStreamPart,
  ToolSet,
} from 'ai';
import { generateText } from 'ai';

import type { AgentRuntimeRunInput, AgentRuntimeRunResult } from '../agents.js';
import {
  createCompactFilter,
  type SummaryAgent,
} from '../compression/index.js';
import type { AgentContext } from '../context.js';
import type {
  DeferredToolApprovalRequest,
  DeferredToolRequests,
} from '../state.js';
import { AgentStreamer } from '../streaming/index.js';

import { normalizeInitialMessages } from './messages.js';

export function emitStreamPart(
  part: TextStreamPart<ToolSet>,
  streamer: AgentStreamer<AgentRuntimeRunResult>,
  partial: ModelMessage,
  appendText: (delta: string) => void,
): void {
  if (part.type === 'text-delta') {
    appendText(part.text);
    streamer.enqueue({
      type: 'message_delta',
      delta: { type: 'text', text: part.text },
      partial: { ...partial },
    });
    return;
  }

  if (part.type === 'tool-input-delta') {
    streamer.enqueue({
      type: 'message_delta',
      delta: {
        type: 'tool_call',
        toolCallId: part.id,
        toolName: '',
        argsDelta: part.delta,
      },
      partial: { ...partial },
    });
    return;
  }

  if (part.type === 'tool-call') {
    streamer.enqueue({
      type: 'tool_execution_start',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      args: part.input,
    });
    return;
  }

  if (part.type === 'tool-result' || part.type === 'tool-error') {
    streamer.enqueue({
      type: 'tool_execution_end',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      result:
        part.type === 'tool-result'
          ? (part as { output?: unknown }).output
          : (part as { error?: unknown }).error,
      isError: part.type === 'tool-error',
    });
  }
}

export async function wrapStreamResult(
  result: ReturnType<typeof streamText<ToolSet>>,
  input: AgentRuntimeRunInput,
  steps: Array<StepResult<ToolSet, Record<string, unknown>>>,
  approvalToolNames: ReadonlySet<string>,
): Promise<AgentRuntimeRunResult> {
  const text = await result.text;
  const usage = await result.usage;
  const responseMessages = (await result.responseMessages) as ModelMessage[];
  const resolvedSteps = steps.length > 0 ? steps : await result.steps;
  const pending = collectDeferredRequests(resolvedSteps, approvalToolNames);
  const output = pending !== null ? pending : text;
  return {
    ...(result as object),
    text,
    usage,
    responseMessages,
    output,
    allMessages: () => [
      ...normalizeInitialMessages(input),
      ...responseMessages,
    ],
  } as AgentRuntimeRunResult;
}

export function collectDeferredRequests(
  steps: Array<StepResult<ToolSet, Record<string, unknown>>>,
  approvalToolNames: ReadonlySet<string>,
): DeferredToolRequests | null {
  const approvals = new Map<string, DeferredToolApprovalRequest>();
  for (const step of steps) {
    for (const toolCall of step.toolCalls) {
      if (approvalToolNames.has(toolCall.toolName)) {
        approvals.set(toolCall.toolCallId, {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        });
      }
    }
  }

  if (approvals.size === 0) {
    return null;
  }

  return {
    approvals: [...approvals.values()],
    calls: [],
  };
}

export async function maybeApplyCompactFilter(
  messageHistory: ModelMessage[],
  ctx: AgentContext,
  compact: boolean,
  summaryModel: LanguageModel,
): Promise<ModelMessage[]> {
  if (!compact) {
    return messageHistory;
  }

  const summaryAgent: SummaryAgent = {
    run: async (input) => {
      const summaryResult = await generateText({
        model: summaryModel,
        messages: [...input.messages, { role: 'user', content: input.prompt }],
      });
      return summaryResult.text;
    },
  };
  const filter = createCompactFilter();
  return filter({ deps: ctx, agent: summaryAgent }, messageHistory);
}
