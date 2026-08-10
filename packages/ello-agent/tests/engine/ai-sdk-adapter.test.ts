/**
 * 本文件验证 ai-sdk-adapter 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildToolSet } from '../../src/features/agent/engine/tools.js';

import type {
  AgentModelEvent,
  AgentModelRequest,
} from '../../src/features/agent/engine/model.js';
import { createAiSdkModelAdapter } from '../../src/features/model/providers/ai-sdk/ai-sdk.js';

describe('AI SDK model adapter', () => {
  it('preserves an invalid Command Run tool call for runtime recovery', async () => {
    const adapter = createAiSdkModelAdapter();
    const input = {
      commands: [
        {
          step: 1,
          command: 'bash',
          body: 'pwd',
          timeoutMs: 30_000,
          cwd: '/app',
          reason: 'inspect the workspace',
        },
      ],
    };
    const tools = buildToolSet({
      tools: [
        {
          name: 'command_run',
          description: 'Run Commands.',
          input: z
            .object({
              commands: z
                .array(
                  z
                    .object({
                      step: z.number().int().positive(),
                      command: z.literal('bash'),
                      body: z.string(),
                    })
                    .strict(),
                )
                .min(1),
            })
            .strict(),
        },
      ],
    });

    const events = await collectEvents(
      adapter.stream(
        createRequest(
          [
            {
              type: 'tool-call',
              toolCallId: 'call_schema_recovery',
              toolName: 'command_run',
              input,
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
              usage: emptyUsage(),
            },
          ],
          tools,
        ),
      ),
    );

    const final = events.at(-1);
    if (final?.type !== 'final') {
      throw new Error('expected final event');
    }
    expect(final.response.toolCalls).toEqual([
      {
        id: 'call_schema_recovery',
        name: 'command_run',
        input,
      },
    ]);
    expect(final.response.finishReason).toBe('tool-calls');
  });

  it('does not emit text deltas for provider tool-call mirror JSON', async () => {
    const mirror =
      '[{"type":"tool-call","toolCallId":"call_1","toolName":"read","input":{"filePath":"README.md"}}]';
    const adapter = createAiSdkModelAdapter();

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

    // 镜像文本最终不作为正文输出，但 provider 确实已经开始流式产出，
    // 因此首字延迟仍应被记录。
    expect(events.map((event) => event.type)).toEqual([
      'stream-start',
      'final',
    ]);
    const final = events[1];
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

  it('keeps malformed non-object tool input provider-safe in history', async () => {
    const adapter = createAiSdkModelAdapter();
    const malformedInput = JSON.stringify(
      JSON.stringify({
        commands: [{ step: 1, command: 'bash', body: 'printf ok' }],
      }),
    );

    const events = await collectEvents(
      adapter.stream(
        createRequest([
          {
            type: 'tool-call',
            toolCallId: 'call_malformed_input',
            toolName: 'command_run',
            input: malformedInput,
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage: emptyUsage(),
          },
        ]),
      ),
    );

    const final = events.at(-1);
    if (final?.type !== 'final') {
      throw new Error('expected final event');
    }
    expect(final.response.toolCalls).toEqual([
      {
        id: 'call_malformed_input',
        name: 'command_run',
        input: {},
      },
    ]);
    expect(final.response.newMessages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_malformed_input',
            toolName: 'command_run',
            input: {},
          },
        ],
      },
    ]);
  });

  it('preserves object tool input when a nested command field is malformed', async () => {
    const adapter = createAiSdkModelAdapter();

    const events = await collectEvents(
      adapter.stream(
        createRequest([
          {
            type: 'tool-call',
            toolCallId: 'call_nested_malformed_input',
            toolName: 'command_run',
            input: {
              commands: JSON.stringify([
                { step: 1, command: 'bash', body: 'printf ok' },
              ]),
            },
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage: emptyUsage(),
          },
        ]),
      ),
    );

    const final = events.at(-1);
    if (final?.type !== 'final') {
      throw new Error('expected final event');
    }
    expect(final.response.toolCalls).toEqual([
      {
        id: 'call_nested_malformed_input',
        name: 'command_run',
        input: {
          commands: JSON.stringify([
            { step: 1, command: 'bash', body: 'printf ok' },
          ]),
        },
      },
    ]);
    expect(final.response.newMessages[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_nested_malformed_input',
          toolName: 'command_run',
          input: {
            commands: JSON.stringify([
              { step: 1, command: 'bash', body: 'printf ok' },
            ]),
          },
        },
      ],
    });
  });

  it('keeps normal text streaming incremental', async () => {
    const adapter = createAiSdkModelAdapter();

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
      { type: 'stream-start' },
      { type: 'text-delta', text: 'he' },
      { type: 'text-delta', text: 'llo' },
      { type: 'final', response: { text: 'hello' } },
    ]);
  });

  it('forwards provider reasoning deltas', async () => {
    const adapter = createAiSdkModelAdapter();
    const events = await collectEvents(
      adapter.stream(
        createRequest([
          { type: 'reasoning-start', id: 'reasoning_1' },
          {
            type: 'reasoning-delta',
            id: 'reasoning_1',
            delta: 'checking context',
          },
          { type: 'reasoning-end', id: 'reasoning_1' },
          {
            type: 'text-start',
            id: 'text_1',
          },
          { type: 'text-delta', id: 'text_1', delta: 'done' },
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
      { type: 'stream-start' },
      { type: 'reasoning-delta', text: 'checking context' },
      { type: 'text-delta', text: 'done' },
      { type: 'final' },
    ]);
  });

  it('recovers orphan provider reasoning parts before AI SDK aggregation', async () => {
    const adapter = createAiSdkModelAdapter();
    const events = await collectEvents(
      adapter.stream(
        createRequest([
          {
            type: 'reasoning-delta',
            id: 'item_orphan:0',
            delta: 'checking context',
          },
          { type: 'reasoning-end', id: 'item_orphan:0' },
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', delta: 'done' },
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
      { type: 'stream-start' },
      { type: 'reasoning-delta', text: 'checking context' },
      { type: 'text-delta', text: 'done' },
      {
        type: 'final',
        response: {
          text: 'done',
          newMessages: [
            {
              role: 'assistant',
              content: [
                { type: 'reasoning', text: 'checking context' },
                { type: 'text', text: 'done' },
              ],
            },
          ],
        },
      },
    ]);
  });

  it('does not duplicate reasoning when a delayed start arrives after its delta', async () => {
    const adapter = createAiSdkModelAdapter();
    const events = await collectEvents(
      adapter.stream(
        createRequest([
          {
            type: 'reasoning-delta',
            id: 'item_delayed:0',
            delta: 'first',
          },
          { type: 'reasoning-start', id: 'item_delayed:0' },
          {
            type: 'reasoning-delta',
            id: 'item_delayed:0',
            delta: ' second',
          },
          { type: 'reasoning-end', id: 'item_delayed:0' },
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', delta: 'done' },
          { type: 'text-end', id: 'text_1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: emptyUsage(),
          },
        ]),
      ),
    );

    const final = events.at(-1);
    if (final?.type !== 'final') {
      throw new Error('expected final event');
    }
    expect(final.response.newMessages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'first second' },
          { type: 'text', text: 'done' },
        ],
      },
    ]);
  });

  it('maps AI SDK cache token details into AgentUsage', async () => {
    const adapter = createAiSdkModelAdapter();
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
      lastInputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
      toolCalls: 0,
    });
  });

  it('streams normal JSON text once it cannot be a tool-call mirror', async () => {
    const adapter = createAiSdkModelAdapter();

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
      { type: 'stream-start' },
      { type: 'text-delta', text: '{"answer"' },
      { type: 'text-delta', text: ':"ok"}' },
      { type: 'final', response: { text: '{"answer":"ok"}' } },
    ]);
  });
});

function createRequest(
  chunks: unknown[],
  tools: AgentModelRequest['tools'] = {},
): AgentModelRequest {
  return {
    runId: 'run_1',
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({ chunks }) as never,
      }),
    }),
    messages: [{ role: 'user', content: 'hi' }],
    tools,
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
