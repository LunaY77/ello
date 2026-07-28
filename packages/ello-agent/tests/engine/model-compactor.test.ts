/**
 * 本文件验证 compact 复用当前主 Agent 模型请求、结构化消息和 provider 缓存前缀。
 */
import { describe, expect, it } from 'vitest';

import {
  createAgent,
  defineTool,
  z,
  type AgentModelRequest,
  type AgentModelResponse,
  type CreateAgentOptions,
  type ModelInput,
} from '../../src/features/agent/engine/index.js';

const testTool = defineTool({
  name: 'noop',
  description: 'No-op tool for compact model tests.',
  discovery: { aliases: [], risk: 'readonly' },
  input: z.object({}).strict(),
  execute: () => null,
});

const modelCall = {
  agentName: 'test-agent',
  modelSelector: 'primary_model',
  configuredModel: 'test-model',
  protocol: 'openai',
  apiModel: 'primary-model',
} as const;

function createTestAgent(
  options: Omit<
    CreateAgentOptions,
    'modelCall' | 'environment' | 'executionTools' | 'modelTools'
  >,
) {
  return createAgent({
    ...options,
    modelCall,
    environment: {},
    executionTools: [testTool],
    modelTools: [testTool],
  });
}

function response(
  request: AgentModelRequest,
  text: string,
): AgentModelResponse {
  return {
    text,
    messages: [...request.messages, { role: 'assistant', content: text }],
    newMessages: [{ role: 'assistant', content: text }],
    usage: {
      requests: 1,
      inputTokens: 2,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
    },
    finishReason: 'stop',
    provider: {},
  };
}

describe('model compactor', () => {
  it('可在进程恢复后按同一主 Agent 配置重建 compact 上下文', async () => {
    const requests: AgentModelRequest[] = [];
    const agent = createTestAgent({
      model: 'test:primary-model',
      instructions: 'stable primary instructions',
      modelAdapter: {
        async generate(request) {
          requests.push(request);
          return response(request, 'restored checkpoint');
        },
        async *stream() {
          throw new Error('Compact must not start a normal Agent run.');
        },
      },
    });

    await expect(
      agent.compact({
        contextMessages: [
          { role: 'user', content: 'old question' },
          { role: 'assistant', content: 'old answer' },
        ],
        messages: [{ role: 'user', content: 'old question' }],
        prompt: 'compact prompt',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ text: 'restored checkpoint' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      instructions: 'stable primary instructions',
      toolChoice: 'none',
      messages: [
        { role: 'user', content: 'old question' },
        { role: 'user', content: 'compact prompt' },
      ],
    });
    await agent.close();
  });

  it('首个主模型输入即可建立 compact 上下文', async () => {
    let compactRequests = 0;
    const agent = createTestAgent({
      model: 'test:model',
      modelAdapter: {
        async generate(request) {
          compactRequests += 1;
          return response(request, 'checkpoint');
        },
        async *stream(request) {
          yield { type: 'final', response: response(request, 'answer') };
        },
      },
      modelInputBudget: { maxInputTokens: 100 },
      compactor: {
        name: 'test-compactor',
        async compact(input) {
          const checkpoint = await input.compact({
            messages: input.messages,
            prompt: 'compact prompt',
            signal: input.signal,
          });
          return {
            messages: input.messages,
            usage: checkpoint.usage,
            report: {
              compactor: 'test-compactor',
              beforeMessageCount: input.messages.length,
              afterMessageCount: input.messages.length,
              summary: checkpoint.text,
              keptMessageCount: input.messages.length,
              tokensBefore: 2,
            },
          };
        },
      },
    });

    await expect(agent.run('long history')).resolves.toMatchObject({
      text: 'answer',
      usage: {
        requests: 2,
        inputTokens: 4,
        outputTokens: 2,
      },
    });
    expect(compactRequests).toBe(1);
    await agent.close();
  });

  it('复用主模型身份、system、tools、设置和缓存消息前缀', async () => {
    const modelRequests: AgentModelRequest[] = [];
    const compactRequests: AgentModelRequest[] = [];
    const preparedInputs: ModelInput[] = [];
    let compactorCalls = 0;
    const agent = createTestAgent({
      model: 'test:primary-model',
      instructions: 'stable primary instructions',
      modelSettings: { temperature: 0 },
      modelAdapter: {
        async generate(request) {
          compactRequests.push(request);
          return response(request, 'checkpoint');
        },
        async *stream(request) {
          modelRequests.push(request);
          yield { type: 'final', response: response(request, 'answer') };
        },
      },
      modelInputBudget: { maxInputTokens: 1_000 },
      modelInput: {
        providerOptions: () => ({
          openai: { promptCacheKey: 'primary-cache-key' },
        }),
        prepare: async (input) => {
          const prepared: ModelInput = {
            ...input,
            messages: input.messages.map((message, index) =>
              index === 0
                ? {
                    ...message,
                    providerOptions: {
                      anthropic: {
                        cacheControl: { type: 'ephemeral', ttl: '1h' },
                      },
                    },
                  }
                : message,
            ),
          };
          preparedInputs.push(prepared);
          return prepared;
        },
      },
      compactor: {
        name: 'test-compactor',
        async compact(input) {
          compactorCalls += 1;
          if (compactorCalls === 1) return null;
          const checkpoint = await input.compact({
            messages: [{ role: 'user', content: 'history' }],
            prompt: 'compact prompt',
            signal: input.signal,
          });
          return {
            messages: input.messages,
            report: {
              compactor: 'test-compactor',
              beforeMessageCount: input.messages.length,
              afterMessageCount: input.messages.length,
              summary: checkpoint.text,
              keptMessageCount: input.messages.length,
              tokensBefore: 4,
            },
          };
        },
      },
    });

    await agent.run('history');
    await agent.run({
      messages: [
        { role: 'user', content: 'history' },
        { role: 'assistant', content: 'answer' },
      ],
      prompt: 'next task',
    });

    expect(modelRequests).toHaveLength(2);
    expect(compactRequests).toHaveLength(1);
    const primaryRequest = modelRequests[0]!;
    const primaryContext = preparedInputs[1]!;
    const compactRequest = compactRequests[0]!;
    expect(compactRequest.model).toBe(primaryRequest.model);
    expect(compactRequest.instructions).toBe(primaryContext.instructions);
    expect(compactRequest.tools).toBe(primaryContext.tools);
    expect(compactRequest.providerOptions).toBe(primaryContext.providerOptions);
    expect(compactRequest.modelSettings).toEqual(primaryRequest.modelSettings);
    expect(compactRequest.messages[0]).toBe(primaryContext.messages[0]);
    expect(compactRequest.messages[1]).toEqual({
      role: 'user',
      content: 'compact prompt',
    });
    expect(compactRequest.toolChoice).toBe('none');
    await agent.close();
  });
});
