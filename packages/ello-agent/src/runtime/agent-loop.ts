import {
  streamText,
  type ModelMessage,
  type StepResult,
  type TextStreamPart,
  type ToolSet,
} from 'ai';

import type {
  AgentRuntime,
  AgentRuntimeRunInput,
  AgentRuntimeRunResult,
} from '../agents.js';
import type { AgentStreamer } from '../streaming/index.js';
import type { ToolArgs } from '../toolsets/index.js';

import {
  agentEnd,
  agentError,
  agentStart,
  messageEnd,
  messageStart,
  turnEnd,
  turnStart,
} from './events.js';
import {
  applyHistoryFilters,
  assertRunInput,
  resolveInitialMessages,
  splitRuntimeInput,
} from './messages.js';
import {
  loadSessionHistory,
  persistCompactionIfNeeded,
  persistModelChange,
  persistSessionRun,
} from './session-persistence.js';
import { collectRuntimeTools } from './tool-execution.js';
import {
  emitStreamPart,
  maybeApplyCompactFilter,
  wrapStreamResult,
} from './turn.js';
import { recordUsageFromResult } from './usage.js';

export async function runAgentLoop(
  runtime: AgentRuntime,
  input: AgentRuntimeRunInput,
  streamer: AgentStreamer<AgentRuntimeRunResult>,
): Promise<void> {
  if (!runtime.entered || runtime.ctx === null) {
    throw new Error(
      "AgentRuntime must be entered via 'await runtime.enter()' before calling stream().",
    );
  }
  assertRunInput(input);

  try {
    runtime.ctx = runtime.ctx.prepareNewRun();
    const runId = runtime.ctx.runId;
    streamer.enqueue(agentStart(runId));
    streamer.enqueue(turnStart(runId, 0));
    const approvalToolNames = new Set<string>();
    const approvalPredicates = new Map<string, (args: ToolArgs) => boolean>();
    const tools = await collectRuntimeTools({
      ctx: runtime.ctx,
      toolsets: runtime.toolsets,
      approvalToolNames,
      approvalPredicates,
    });
    const base = {
      model: runtime.model,
      tools,
      ...(runtime.modelSettings !== null ? runtime.modelSettings : {}),
      ...(runtime.systemPrompt !== null ? { system: runtime.systemPrompt } : {}),
    };
    await persistModelChange(runtime.session, runtime.modelName);
    const steps: Array<StepResult<ToolSet, Record<string, unknown>>> = [];
    const onStepEnd = (step: StepResult<ToolSet, Record<string, unknown>>) => {
      steps.push(step);
    };

    const { originalMessages, messages, sdkOptions } =
      await prepareLoopMessages(runtime, input);

    const assistantMessage: ModelMessage = { role: 'assistant', content: '' };
    let text = '';
    streamer.run = {
      result: null,
      allMessages: () => [...originalMessages],
    };
    streamer.enqueue(messageStart(assistantMessage));

    const request = {
      modelName: runtime.modelName,
      baseUrl: runtime.baseUrl,
      payload: { messages },
    };
    const hookRequest =
      (await runtime.providerHooks?.beforeRequest?.(request)) ?? request;
    const payload =
      (await runtime.providerHooks?.beforePayload?.(hookRequest.payload)) ??
      hookRequest.payload;
    const hookMessages =
      typeof payload === 'object' &&
      payload !== null &&
      'messages' in payload &&
      Array.isArray((payload as { messages?: unknown }).messages)
        ? (payload as { messages: ModelMessage[] }).messages
        : messages;

    const result = streamText({
      ...base,
      ...sdkOptions,
      allowSystemInMessages: true,
      messages: hookMessages,
      onStepEnd,
    });

    for await (const part of result.stream as AsyncIterable<TextStreamPart<ToolSet>>) {
      emitStreamPart(part, streamer, assistantMessage, (delta) => {
        text += delta;
        assistantMessage.content = text;
      });
    }

    const finalResult = await wrapStreamResult(
      result,
      input,
      steps,
      approvalToolNames,
      approvalPredicates,
    );
    await runtime.providerHooks?.afterResponse?.({
      modelName: runtime.modelName,
      body: finalResult.responseMessages,
    });
    recordUsageFromResult(runtime.ctx, finalResult, 'main', runtime.modelName);
    await persistSessionRun(runtime.session, input, finalResult);
    const allMessages = finalResult.allMessages();
    streamer.run = {
      result: { output: finalResult.output },
      allMessages: () => allMessages,
    };
    const finalMessage = allMessages.at(-1) ?? assistantMessage;
    streamer.enqueue(messageEnd(finalMessage));
    streamer.enqueue(
      turnEnd(
        finalMessage,
        allMessages.filter((message) => message.role === 'tool'),
      ),
    );
    streamer.enqueue(agentEnd(allMessages));
    streamer.setResult(finalResult);
    streamer.finish();
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    streamer.enqueue(agentError(normalized, streamer.recoverableMessages() ?? []));
    throw error;
  }
}

async function prepareLoopMessages(
  runtime: AgentRuntime,
  input: AgentRuntimeRunInput,
): Promise<{
  originalMessages: ModelMessage[];
  messages: ModelMessage[];
  sdkOptions: Record<string, unknown>;
}> {
  if (runtime.ctx === null) {
    throw new Error('AgentRuntime context is not available.');
  }

  if (typeof input === 'string') {
    const sessionHistory = await loadSessionHistory(runtime.session);
    const originalMessages = await applyHistoryFilters(
      resolveInitialMessages(input, null, null, sessionHistory),
      runtime.ctx,
      runtime.env,
    );
    return {
      originalMessages,
      messages: originalMessages,
      sdkOptions: {},
    };
  }

  const runtimeInput = splitRuntimeInput(input);
  const sessionHistory = await loadSessionHistory(runtime.session);
  const initialMessages = await applyHistoryFilters(
    resolveInitialMessages(
      runtimeInput.promptText,
      runtimeInput.promptMessages,
      runtimeInput.messages,
      sessionHistory,
    ),
    runtime.ctx,
    runtime.env,
  );
  const compactedMessages = await maybeApplyCompactFilter(
    initialMessages,
    runtime.ctx,
    runtime.compact,
    runtime.summaryModel ?? runtime.model,
  );
  await persistCompactionIfNeeded(
    runtime.session,
    initialMessages,
    compactedMessages,
  );
  return {
    originalMessages: initialMessages,
    messages: compactedMessages,
    sdkOptions: runtimeInput.sdkOptions as Record<string, unknown>,
  };
}
