/**
 * 本文件验证模型流瞬时失败后的有界恢复行为。
 *
 * 测试通过真实 Agent engine 观察失败轮与恢复轮的事件顺序；provider cause 必须保留，
 * 部分输出不得阻止同一 run 恢复完成。
 */
import { describe, expect, it } from 'vitest';

import {
  createAgent,
  MAX_MODEL_OUTPUT_TOKENS,
  MAX_REASONING_CHARS_PER_CALL,
  z,
  type AgentModelRequest,
  type AgentModelResponse,
  type EngineEvent,
} from '../../src/features/agent/engine/index.js';
import { createTestCommandRun, defineTestCommand } from '../support/command.js';
import { createTestEnvironmentHandle } from '../support/environment.js';

const noopTool = defineTestCommand({
  name: 'test_noop',
  summary: 'No-op tool for model retry tests.',
  schema: z.object({}).strict(),
  run: () => null,
});

describe('model stream retry', () => {
  it('steers into a fresh turn when a stream exhausts its reasoning budget', async () => {
    let streamCalls = 0;
    const agent = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelAdapter: {
        generate: echoResponse,
        async *stream(request) {
          streamCalls += 1;
          if (streamCalls === 1) {
            yield {
              type: 'reasoning-delta',
              text: 'x'.repeat(MAX_REASONING_CHARS_PER_CALL + 1),
            } as const;
            return;
          }
          yield { type: 'text-delta', text: 'continued' } as const;
          yield {
            type: 'final',
            response: {
              ...(await echoResponse(request)),
              text: 'continued',
            },
          } as const;
        },
      },
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([noopTool]),
    });
    const stream = agent.stream('hi');
    const events: EngineEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.final;

    expect(result.output).toBe('continued');
    expect(streamCalls).toBe(2);
    expect(
      events.filter((event) => event.type === 'model.interrupted'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'model.failed'),
    ).toHaveLength(0);
    await agent.close();
  });

  it('caps an oversized output budget before handing the request to the adapter', async () => {
    let observed: AgentModelRequest | undefined;
    const agent = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelSettings: { maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS * 4 },
      modelAdapter: {
        generate: echoResponse,
        async *stream(request) {
          observed = request;
          yield {
            type: 'final',
            response: await echoResponse(request),
          } as const;
        },
      },
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([noopTool]),
    });

    await agent.run('hi');

    expect(observed?.modelSettings.maxOutputTokens).toBe(
      MAX_MODEL_OUTPUT_TOKENS,
    );
    await agent.close();
  });

  it('continues when the provider throws after a budget-triggered abort', async () => {
    let streamCalls = 0;
    const agent = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelAdapter: {
        generate: echoResponse,
        async *stream(request) {
          streamCalls += 1;
          if (streamCalls === 1) {
            yield {
              type: 'reasoning-delta',
              text: 'x'.repeat(MAX_REASONING_CHARS_PER_CALL + 1),
            } as const;
            throw Object.assign(new Error('aborted by client'), {
              name: 'AbortError',
            });
          }
          yield { type: 'text-delta', text: 'continued' } as const;
          yield {
            type: 'final',
            response: {
              ...(await echoResponse(request)),
              text: 'continued',
            },
          } as const;
        },
      },
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([noopTool]),
    });
    const stream = agent.stream('hi');
    const events: EngineEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.final;

    expect(result.output).toBe('continued');
    expect(streamCalls).toBe(2);
    expect(
      events.filter((event) => event.type === 'model.interrupted'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'model.failed'),
    ).toHaveLength(0);
    await agent.close();
  });

  it('retries transient stream failures after partial output', async () => {
    let streamCalls = 0;
    const agent = createAgent({
      model: 'test:model',
      modelCall: {
        agentName: 'test-agent',
        modelSelector: 'primary_model',
        configuredModel: 'test-model',
        protocol: 'openai',
        apiModel: 'model',
      },
      modelAdapter: {
        generate: echoResponse,
        async *stream(request) {
          streamCalls += 1;
          if (streamCalls === 1) {
            yield { type: 'reasoning-delta', text: 'partial' } as const;
            const cause = Object.assign(new Error('socket closed'), {
              code: 'UND_ERR_SOCKET',
            });
            throw new TypeError('terminated', { cause });
          }
          yield { type: 'text-delta', text: 'hello' } as const;
          yield {
            type: 'final',
            response: await echoResponse(request),
          } as const;
        },
      },
      environment: createTestEnvironmentHandle(),
      commandRun: createTestCommandRun([noopTool]),
    });
    const stream = agent.stream('hi');
    const events: EngineEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.final;

    expect(result.output).toBe('hello');
    expect(streamCalls).toBe(2);
    expect(
      events.filter((event) => event.type === 'model.failed'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'model.started'),
    ).toHaveLength(2);
    expect(events.find((event) => event.type === 'model.failed')).toMatchObject(
      {
        error: {
          name: 'TypeError',
          message: 'terminated',
          cause: {
            name: 'Error',
            message: 'socket closed',
            code: 'UND_ERR_SOCKET',
          },
        },
      },
    );
    await agent.close();
  });
});

function echoResponse(request: AgentModelRequest): Promise<AgentModelResponse> {
  return Promise.resolve({
    text: 'hello',
    messages: [...request.messages, { role: 'assistant', content: 'hello' }],
    newMessages: [{ role: 'assistant', content: 'hello' }],
    usage: {
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
    },
    finishReason: 'stop',
    provider: { ok: true },
  });
}
