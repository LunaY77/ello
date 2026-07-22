/**
 * 本文件验证 model-call-observer 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { describe, expect, it } from 'vitest';

import type {
  AgentEventRecorder,
  AgentModelRequest,
  AgentModelResponse,
  EngineEvent,
  ModelAdapter,
  AnyAgentTool,
  CreateAgentOptions,
} from '../../src/features/agent/engine/index.js';
import {
  createAgent as createBaseAgent,
  defineTool,
  z,
} from '../../src/features/agent/engine/index.js';

const testTool = defineTool({
  name: 'test_noop',
  description: 'No-op tool for model observer tests.',
  discovery: { aliases: ['noop'], risk: 'readonly' },
  input: z.object({}).strict(),
  execute: () => null,
});

function createAgent(
  options: Omit<
    CreateAgentOptions,
    'executionTools' | 'modelTools' | 'environment'
  > & {
    readonly tools?: readonly AnyAgentTool[];
  },
) {
  const { tools, ...rest } = options;
  const selected = tools ?? [testTool as AnyAgentTool];
  return createBaseAgent({
    ...rest,
    environment: {},
    executionTools: selected,
    modelTools: selected,
  });
}

const usage = {
  requests: 1,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  toolCalls: 0,
};

class FinalAdapter implements ModelAdapter {
  async generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    const message = { role: 'assistant' as const, content: 'done' };
    return {
      text: 'done',
      messages: [...request.messages, message],
      newMessages: [message],
      usage,
      finishReason: 'stop',
      provider: null,
    };
  }

  async *stream(request: AgentModelRequest) {
    yield { type: 'final' as const, response: await this.generate(request) };
  }
}

describe('model-call lifecycle', () => {
  it('上报安全的 model-call usage 与 fingerprint', async () => {
    const calls: Extract<EngineEvent, { type: 'model.completed' }>[] = [];
    const recorder: AgentEventRecorder = {
      record: (event) => {
        if (event.type === 'model.completed') calls.push(event);
      },
    };
    const agent = createAgent({
      model: 'test:model-a',
      modelAdapter: new FinalAdapter(),
      instructions: 'stable system',
      eventRecorder: recorder,
    });

    await agent.run('hello');
    await agent.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      identity: { turnIndex: 0, provider: 'test', model: 'model-a' },
      response: { finishReason: 'stop', usage },
      diagnostics: { compactionBoundary: false },
    });
    expect(
      Date.parse(calls[0]!.occurredAt) - Date.parse(calls[0]!.startedAt),
    ).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.diagnostics.systemFingerprint).toHaveLength(64);
    expect(calls[0]?.diagnostics.toolsetFingerprint).toHaveLength(64);
    expect(calls[0]?.diagnostics.messagePrefixFingerprint).toHaveLength(64);
  });

  it('工具 schema 变化会改变 toolset fingerprint', async () => {
    const fingerprints: string[] = [];
    const runWithSchema = async (input: z.ZodType): Promise<void> => {
      const agent = createAgent({
        model: 'test:model-a',
        modelAdapter: new FinalAdapter(),
        tools: [
          defineTool({
            name: 'lookup',
            description: 'Lookup a value',
            discovery: { aliases: ['lookup'], risk: 'readonly' },
            input,
            execute: () => 'unused',
          }),
        ],
        eventRecorder: {
          record: (event) => {
            if (event.type === 'model.completed') {
              fingerprints.push(event.diagnostics.toolsetFingerprint);
            }
          },
        },
      });
      await agent.run('hello');
      await agent.close();
    };

    await runWithSchema(z.object({ key: z.string() }));
    await runWithSchema(z.object({ key: z.number() }));

    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });
});
