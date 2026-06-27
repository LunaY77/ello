import { describe, expect, it } from 'vitest';

import type { AgentRuntime, AgentRuntimeRunInput } from '../agents.js';
import {
  AgentInterrupted,
  AgentStreamer,
  PartialTextAccumulator,
  streamAgent,
  type AgentStreamEvent,
} from '../index.js';

describe('PartialTextAccumulator', () => {
  it('accumulates TS-first message events', () => {
    const accumulator = new PartialTextAccumulator();

    accumulator.observe({
      type: 'message_start',
      message: { role: 'assistant', content: '' },
    });
    accumulator.observe({
      type: 'message_delta',
      delta: { type: 'text', text: 'hel' },
      partial: { role: 'assistant', content: 'hel' },
    });
    accumulator.observe({
      type: 'message_delta',
      delta: { type: 'text', text: 'lo' },
      partial: { role: 'assistant', content: 'hello' },
    });

    expect(accumulator.buildResponse()).toEqual({
      role: 'assistant',
      content: 'hello',
    });
  });

  it('resets accumulated partial message', () => {
    const accumulator = new PartialTextAccumulator();

    accumulator.observe({
      type: 'message_end',
      message: { role: 'assistant', content: 'done' },
    });
    expect(accumulator.buildResponse()).toEqual({
      role: 'assistant',
      content: 'done',
    });

    accumulator.reset();

    expect(accumulator.buildResponse()).toBeNull();
  });
});

describe('closeUnreturnedToolCalls', () => {
  it('keeps messages unchanged when all tool calls returned', async () => {
    const { closeUnreturnedToolCalls } = await import('../index.js');
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: {},
          },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'call-1',
            toolName: 'lookup',
            output: { type: 'text' as const, value: 'ok' },
          },
        ],
      },
    ];

    expect(closeUnreturnedToolCalls(messages)).toBe(messages);
  });

  it('adds failure results for pending tool calls', async () => {
    const { closeUnreturnedToolCalls } = await import('../index.js');
    const result = closeUnreturnedToolCalls([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-b',
            toolName: 'second',
            input: {},
          },
          {
            type: 'tool-call',
            toolCallId: 'call-a',
            toolName: 'first',
            input: {},
          },
        ],
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-a',
          toolName: 'first',
          output: {
            type: 'text',
            value:
              '[Error: tool execution was interrupted before returning a result]',
          },
        },
        {
          type: 'tool-result',
          toolCallId: 'call-b',
          toolName: 'second',
          output: {
            type: 'text',
            value:
              '[Error: tool execution was interrupted before returning a result]',
          },
        },
      ],
    });
  });
});

describe('AgentStreamer', () => {
  it('iterates queued events and finishes', async () => {
    const streamer = new AgentStreamer();
    const event: AgentStreamEvent = { type: 'agent_start', runId: 'run-1' };

    streamer.enqueue(event);
    streamer.finish();

    await expect(streamer.next()).resolves.toEqual({
      done: false,
      value: event,
    });
    await expect(streamer.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('rejects pending iteration on failure', async () => {
    const streamer = new AgentStreamer();
    const pending = streamer.next();
    const error = new Error('boom');

    streamer.fail(error);

    await expect(pending).rejects.toBe(error);
    expect(() => streamer.throwIfException()).toThrow(error);
  });

  it('marks interruption and exposes interrupted error', () => {
    const streamer = new AgentStreamer();

    streamer.interrupt();

    expect(streamer.isInterrupted).toBe(true);
    expect(streamer.exception).toBeInstanceOf(AgentInterrupted);
  });

  it('builds recoverable messages and state', async () => {
    const streamer = new AgentStreamer({
      run: {
        result: { output: 'base' },
        allMessages: () => [{ role: 'user', content: 'hello' }],
      },
    });

    streamer.enqueue({
      type: 'message_delta',
      delta: { type: 'text', text: 'partial' },
      partial: { role: 'assistant', content: 'partial' },
    });
    streamer.finish();
    await streamer.next();

    expect(streamer.recoverableMessages()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial' },
    ]);
    expect(streamer.state?.messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('resolves final result', async () => {
    const streamer = new AgentStreamer<string>();

    streamer.setResult('done');

    await expect(streamer.result()).resolves.toBe('done');
  });
});

describe('streamAgent', () => {
  it('auto-enters and exits runtime', async () => {
    const runtime = new FakeRuntime();
    const streamer = streamAgent(runtime as unknown as AgentRuntime, 'hello');
    const events = await collectEvents(streamer);

    expect(runtime.lastInput).toBe('hello');
    expect(runtime.enterCalls).toBe(1);
    expect(runtime.exitCalls).toBe(1);
    expect(events).toEqual([{ type: 'agent_end', messages: [] }]);
  });

  it('reuses an entered runtime', async () => {
    const runtime = new FakeRuntime();
    await runtime.enter();

    const streamer = streamAgent(runtime as unknown as AgentRuntime, 'hello');
    const events = await collectEvents(streamer);

    expect(runtime.lastInput).toBe('hello');
    expect(runtime.enterCalls).toBe(1);
    expect(runtime.exitCalls).toBe(0);
    expect(events).toEqual([{ type: 'agent_end', messages: [] }]);
  });
});

async function collectEvents(
  streamer: AsyncIterable<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamer) {
    events.push(event);
  }
  return events;
}

class FakeRuntime {
  lastInput: AgentRuntimeRunInput | null = null;
  enterCalls = 0;
  exitCalls = 0;

  get entered(): boolean {
    return this.enterCalls > this.exitCalls;
  }

  async enter(): Promise<this> {
    this.enterCalls += 1;
    return this;
  }

  async exit(): Promise<void> {
    this.exitCalls += 1;
  }

  stream(input: AgentRuntimeRunInput): AgentStreamer {
    this.lastInput = input;
    const streamer = new AgentStreamer();
    streamer.enqueue({ type: 'agent_end', messages: [] });
    streamer.setResult({ output: 'done', allMessages: () => [] });
    streamer.finish();
    return streamer;
  }
}
