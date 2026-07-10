import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { AiSdkModelAdapter } from '../adapters/ai-sdk.js';
import type { AgentModelEvent, AgentModelRequest } from '../public/types.js';

describe('AiSdkModelAdapter', () => {
  it('does not emit text deltas for provider tool-call mirror JSON', async () => {
    const mirror =
      '[{"type":"tool-call","toolCallId":"call_1","toolName":"read","input":{"path":"README.md"}}]';
    const adapter = new AiSdkModelAdapter();

    const events = await collectEvents(
      adapter.stream(
        createRequest([
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', delta: mirror.slice(0, 24) },
          { type: 'text-delta', id: 'text_1', delta: mirror.slice(24) },
          { type: 'text-end', id: 'text_1' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'read',
            input: { path: 'README.md' },
          },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: emptyUsage(),
          },
        ]),
      ),
    );

    expect(events.map((event) => event.type)).toEqual(['final']);
    const final = events[0];
    expect(final?.type).toBe('final');
    if (final?.type !== 'final') {
      throw new Error('expected final event');
    }
    expect(final.response.text).toBe('');
    expect(final.response.toolCalls).toEqual([
      { id: 'call_1', name: 'read', input: { path: 'README.md' } },
    ]);
    expect(final.response.newMessages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'read',
            input: { path: 'README.md' },
          },
        ],
      },
    ]);
  });

  it('keeps normal text streaming incremental', async () => {
    const adapter = new AiSdkModelAdapter();

    const events = await collectEvents(
      adapter.stream(
        createRequest([
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', delta: 'he' },
          { type: 'text-delta', id: 'text_1', delta: 'llo' },
          { type: 'text-end', id: 'text_1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: emptyUsage(),
          },
        ]),
      ),
    );

    expect(events).toMatchObject([
      { type: 'text-delta', text: 'he' },
      { type: 'text-delta', text: 'llo' },
      { type: 'final', response: { text: 'hello' } },
    ]);
  });

  it('maps AI SDK cache token details into AgentUsage', async () => {
    const adapter = new AiSdkModelAdapter();
    const events = await collectEvents(
      adapter.stream(
        createRequest([
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', delta: 'ok' },
          { type: 'text-end', id: 'text_1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 100,
                noCache: 20,
                cacheRead: 70,
                cacheWrite: 10,
              },
              outputTokens: { total: 25, text: 25, reasoning: 0 },
            },
          },
        ]),
      ),
    );
    const final = events.at(-1);
    if (final?.type !== 'final') {
      throw new Error('expected final event');
    }
    expect(final.response.usage).toEqual({
      requests: 1,
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
      toolCalls: 0,
    });
  });

  it('streams normal JSON text once it cannot be a tool-call mirror', async () => {
    const adapter = new AiSdkModelAdapter();

    const events = await collectEvents(
      adapter.stream(
        createRequest([
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', delta: '{"answer"' },
          { type: 'text-delta', id: 'text_1', delta: ':"ok"}' },
          { type: 'text-end', id: 'text_1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: emptyUsage(),
          },
        ]),
      ),
    );

    expect(events).toMatchObject([
      { type: 'text-delta', text: '{"answer"' },
      { type: 'text-delta', text: ':"ok"}' },
      { type: 'final', response: { text: '{"answer":"ok"}' } },
    ]);
  });
});

function createRequest(chunks: unknown[]): AgentModelRequest {
  return {
    runId: 'run_1',
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({ chunks }),
      }),
    }),
    messages: [{ role: 'user', content: 'hi' }],
    tools: {},
    modelSettings: {},
  };
}

function emptyUsage() {
  return {
    inputTokens: {
      total: 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: 0,
      text: 0,
      reasoning: 0,
    },
  };
}

async function collectEvents(
  stream: AsyncIterable<AgentModelEvent>,
): Promise<AgentModelEvent[]> {
  const events: AgentModelEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
