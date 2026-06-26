import type { ModelMessage } from 'ai';

import type { AgentRuntime, AgentRuntimeRunInput } from '../agents.js';
import type { StreamCompleteEvent, StreamStartEvent } from '../events.js';

import { AgentStreamer } from './streamer.js';

/** streamAgent 参数。 */
export interface StreamAgentOptions {
  agentId?: string;
  agentName?: string;
}

/** 流式执行 agent。 */
export function streamAgent(
  runtime: AgentRuntime,
  input: AgentRuntimeRunInput,
  options: StreamAgentOptions = {},
): AgentStreamer {
  const streamer = new AgentStreamer();
  const task = runStream(runtime, input, streamer, options);
  streamer.addTask(task);
  return streamer;
}

async function runStream(
  runtime: AgentRuntime,
  input: AgentRuntimeRunInput,
  streamer: AgentStreamer,
  options: StreamAgentOptions,
): Promise<void> {
  const autoEnter = !runtime.entered;
  const agentId = options.agentId ?? 'main';
  const agentName = options.agentName ?? 'main';

  if (autoEnter) {
    await runtime.enter();
  }

  const ctx = runtime.ctx;
  if (ctx !== null) {
    const startEvent: StreamStartEvent = {
      runId: ctx.runId,
      timestamp: new Date(),
      promptPreview: inputPreview(input),
    };
    ctx.emitEvent(startEvent);
  }

  try {
    const result = await runtime.run(input);
    const text = extractText(result);
    const messages = buildMessages(input, text);
    streamer.run = {
      result: { output: text },
      allMessages: () => messages,
    };

    streamer.enqueue({
      agentId,
      agentName,
      event: {
        eventKind: 'part_start',
        index: 0,
        part: { type: 'text', text: '' },
      },
    });
    if (text.length > 0) {
      streamer.enqueue({
        agentId,
        agentName,
        event: {
          eventKind: 'part_delta',
          index: 0,
          delta: { deltaKind: 'text', contentDelta: text },
        },
      });
    }
    streamer.enqueue({
      agentId,
      agentName,
      event: {
        eventKind: 'part_end',
        index: 0,
        part: { type: 'text', text },
      },
    });

    if (runtime.ctx !== null) {
      const completeEvent: StreamCompleteEvent = {
        runId: runtime.ctx.runId,
        timestamp: new Date(),
        success: true,
      };
      runtime.ctx.emitEvent(completeEvent);
    }
    streamer.finish();
  } catch (error) {
    if (runtime.ctx !== null) {
      const completeEvent: StreamCompleteEvent = {
        runId: runtime.ctx.runId,
        timestamp: new Date(),
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      runtime.ctx.emitEvent(completeEvent);
    }
    streamer.fail(error);
  } finally {
    if (autoEnter) {
      await runtime.exit();
    }
  }
}

function extractText(result: Awaited<ReturnType<AgentRuntime['run']>>): string {
  if (typeof result === 'object' && result !== null && 'text' in result) {
    return String((result as { text?: unknown }).text ?? '');
  }
  return String(result ?? '');
}

function buildMessages(
  input: AgentRuntimeRunInput,
  text: string,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if ('messages' in input && input.messages !== undefined) {
    messages.push(...input.messages);
  } else if ('prompt' in input && typeof input.prompt === 'string') {
    messages.push({ role: 'user', content: input.prompt });
  } else if ('prompt' in input && Array.isArray(input.prompt)) {
    messages.push(...input.prompt);
  }
  messages.push({ role: 'assistant', content: text });
  return messages;
}

function inputPreview(input: AgentRuntimeRunInput): string {
  const text =
    typeof input === 'string'
      ? input
      : 'prompt' in input && typeof input.prompt === 'string'
        ? input.prompt
        : 'messages' in input
          ? JSON.stringify(input.messages).slice(0, 100)
          : '(stream)';
  return text.length > 100 ? `${text.slice(0, 100)}...` : text;
}
