import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import type { AgentRuntime, AgentRuntimeRunInput } from '../agents.js';
import { AgentContext } from '../context.js';
import { LocalEnvironment } from '../environment/index.js';
import {
  AgentInterrupted,
  AgentStreamer,
  PartialTextAccumulator,
  closeUnreturnedToolCalls,
  streamAgent,
  type StreamEvent,
} from '../index.js';

describe('PartialTextAccumulator', () => {
  it('returns null without observed parts', () => {
    const accumulator = new PartialTextAccumulator();

    expect(accumulator.buildResponse()).toBeNull();
  });

  it('accumulates start, delta and end events', () => {
    const accumulator = new PartialTextAccumulator();

    accumulator.observe({
      eventKind: 'part_start',
      index: 0,
      part: { type: 'text', text: 'hel' },
    });
    accumulator.observe({
      eventKind: 'part_delta',
      index: 0,
      delta: { deltaKind: 'text', contentDelta: 'lo' },
    });
    accumulator.observe({
      eventKind: 'part_end',
      index: 0,
      part: { type: 'text', text: 'hello!' },
    });

    expect(accumulator.buildResponse()).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello!' }],
    });
  });

  it('sorts parts and can reset', () => {
    const accumulator = new PartialTextAccumulator();

    accumulator.observe({
      eventKind: 'part_start',
      index: 1,
      part: { type: 'text', text: 'b' },
    });
    accumulator.observe({
      eventKind: 'part_start',
      index: 0,
      part: { type: 'text', text: 'a' },
    });

    expect(accumulator.buildResponse()).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });

    accumulator.reset();

    expect(accumulator.buildResponse()).toBeNull();
  });
});

describe('closeUnreturnedToolCalls', () => {
  it('keeps messages unchanged when all tool calls returned', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'lookup',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
    ];

    expect(closeUnreturnedToolCalls(messages)).toBe(messages);
  });

  it('adds failure results for pending tool calls', () => {
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
    const event = textEvent('done');

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

    streamer.enqueue(textEvent('partial'));
    streamer.finish();
    await streamer.next();

    expect(streamer.recoverableMessages()).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
      },
    ]);
    expect(streamer.state?.messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });
});

describe('streamAgent', () => {
  it('auto-enters runtime and emits synthetic text events', async () => {
    const runtime = new FakeRuntime('hello');
    const streamer = streamAgent(runtime as unknown as AgentRuntime, 'say hi');
    const events = await collectEvents(streamer);

    expect(runtime.enterCalls).toBe(1);
    expect(runtime.exitCalls).toBe(1);
    expect(events.map((item) => item.event.eventKind)).toEqual([
      'part_start',
      'part_delta',
      'part_end',
    ]);
    expect(streamer.run?.allMessages()).toEqual([
      { role: 'user', content: 'say hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('does not exit an already-entered runtime', async () => {
    const runtime = new FakeRuntime('');
    await runtime.enter();

    const streamer = streamAgent(runtime as unknown as AgentRuntime, {
      prompt: 'hello',
    });
    const events = await collectEvents(streamer);

    expect(runtime.enterCalls).toBe(1);
    expect(runtime.exitCalls).toBe(0);
    expect(events.map((item) => item.event.eventKind)).toEqual([
      'part_start',
      'part_end',
    ]);
  });

  it('emits lifecycle events on success', async () => {
    const runtime = new FakeRuntime('done');
    const streamer = streamAgent(runtime as unknown as AgentRuntime, 'input');

    await collectEvents(streamer);

    expect(runtime.lastEvents()).toMatchObject([
      { promptPreview: 'input' },
      { success: true },
    ]);
  });

  it('propagates run errors and still exits auto-entered runtime', async () => {
    const runtime = new FakeRuntime('unused', new Error('model failed'));
    const streamer = streamAgent(runtime as unknown as AgentRuntime, 'input');

    await expect(streamer.next()).rejects.toThrow('model failed');
    expect(runtime.exitCalls).toBe(1);
    expect(runtime.lastEvents()).toMatchObject([
      { promptPreview: 'input' },
      { success: false, error: 'model failed' },
    ]);
  });
});

function textEvent(text: string): StreamEvent {
  return {
    agentId: 'main',
    agentName: 'main',
    event: {
      eventKind: 'part_end',
      index: 0,
      part: { type: 'text', text },
    },
  };
}

async function collectEvents(streamer: AgentStreamer): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamer) {
    events.push(event);
  }
  return events;
}

class FakeRuntime {
  readonly env = new LocalEnvironment();
  ctx: AgentContext | null = null;
  enterCalls = 0;
  exitCalls = 0;
  private readonly contexts: AgentContext[] = [];

  constructor(
    private readonly text: string,
    private readonly error: Error | null = null,
  ) {}

  get entered(): boolean {
    return this.ctx !== null;
  }

  async enter(): Promise<this> {
    this.enterCalls += 1;
    await this.env.enter();
    this.ctx = new AgentContext({ env: this.env });
    this.contexts.push(this.ctx);
    return this;
  }

  async exit(): Promise<void> {
    this.exitCalls += 1;
    await this.env.exit();
    this.ctx = null;
  }

  async run(_input: AgentRuntimeRunInput): Promise<{ text: string }> {
    if (this.ctx === null) {
      throw new Error('runtime is not entered');
    }
    this.ctx = this.ctx.prepareNewRun();
    this.contexts.push(this.ctx);
    if (this.error !== null) {
      throw this.error;
    }
    return { text: this.text };
  }

  lastEvents(): unknown[] {
    return this.contexts.flatMap((ctx) => ctx.events);
  }
}
