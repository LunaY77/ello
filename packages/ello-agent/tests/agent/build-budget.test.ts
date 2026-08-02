/**
 * 验证产品 Agent 装配只使用 model resolution 产生的有效输入预算，不会回退到更宽的原始 config。
 */
import { describe, expect, it } from 'vitest';

import { buildAgent } from '../../src/features/agent/build.js';
import type {
  AgentRunRequest,
  CreateAgentFeatureInput,
} from '../../src/features/agent/contracts.js';
import {
  defineTool,
  z,
  type AgentModelRequest,
  type AgentModelResponse,
} from '../../src/features/agent/engine/index.js';
import type { AgentRegistry } from '../../src/features/agent/subagents/index.js';
import type { CodingAgentDefinition } from '../../src/features/agent/subagents/schema.js';
import { CodingAgentConfigSchema } from '../../src/features/config/index.js';
import { createTestEnvironmentHandle } from '../support/environment.js';

const tool = defineTool({
  name: 'noop',
  description: 'No-op.',
  discovery: { aliases: [], risk: 'readonly' },
  input: z.object({}).strict(),
  execute: () => null,
});

describe('buildAgent model input budget', () => {
  it('uses the model-resolution budget for request trimming and compaction', async () => {
    const config = CodingAgentConfigSchema.parse({
      cwd: '/workspace',
      initial_mode: 'ask-before-changes',
      models: {
        test: {
          protocol: 'openai',
          endpoint: 'responses',
          api_model: 'test-model',
          base_url: 'https://api.example.test/v1',
          api_key_env: 'TEST_API_KEY',
          context_window: 1_000,
          max_output_tokens: 100,
          reasoning_effort: 'low',
        },
      },
      primary_model: 'test',
      auxiliary_model: 'test',
      context: {
        max_input_tokens: 1_000,
        reserved_output_tokens: 1,
        compaction: {
          auto: true,
          tail_turns: 1,
          preserve_recent_tokens: 2,
          reserved_tokens: 5,
          prune_tool_output: false,
          tool_output_max_chars: 2_000,
          split_turns: true,
        },
      },
    });
    const definition: CodingAgentDefinition = {
      name: 'build',
      mode: 'primary',
      model: 'primary_model',
      description: 'test',
      source: 'builtin',
      maxTurns: 1,
    };
    const registry: AgentRegistry = {
      get: () => definition,
      list: () => [definition],
      selectablePrimaries: () => [definition],
      delegatable: () => [],
    };
    let requestSeen: AgentModelRequest | undefined;
    let factoryContextWindow: number | undefined;
    let runtimeContextWindow: number | undefined;
    const response = (request: AgentModelRequest): AgentModelResponse => ({
      text: 'done',
      messages: [...request.messages, { role: 'assistant', content: 'done' }],
      newMessages: [{ role: 'assistant', content: 'done' }],
      usage: {
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: 0,
      },
      finishReason: 'stop',
      provider: {},
    });
    const dependencies: CreateAgentFeatureInput = {
      resolveDefinition: async () => ({
        config,
        definition,
        agentRegistry: registry,
      }),
      resolveModel: async () => ({
        modelCall: {
          agentName: 'build',
          modelSelector: 'primary_model',
          configuredModel: 'test',
          protocol: 'openai',
          apiModel: 'test-model',
        },
        model: 'test:model',
        modelAdapter: {
          async generate(request) {
            requestSeen = request;
            return response(request);
          },
          async *stream(request) {
            requestSeen = request;
            yield { type: 'final', response: response(request) };
          },
        },
        modelSettings: { maxOutputTokens: 100 },
        modelInputBudget: {
          maxInputTokens: 60,
          reservedOutputTokens: 1,
        },
        contextWindow: 59,
        providerOptions: () => undefined,
        prepareModelInput: async (input) => input,
      }),
      loadContext: async () => ({
        skills: [],
        activationTool: tool,
        readRoots: () => [],
        createSystemSections: () => [],
      }),
      createTools: async () => ({
        executionTools: [tool],
        modelTools: [tool],
        goalSystemSection: () => null,
        mode: () => 'ask-before-changes',
        setMode: () => undefined,
      }),
      createCompactor: (input) => {
        factoryContextWindow = input.contextWindow;
        return {
          name: 'test-compactor',
          compact(compactionInput) {
            runtimeContextWindow = compactionInput.contextWindow;
            return null;
          },
        };
      },
      runtime: {
        environments: {
          attach: () => Promise.resolve(createTestEnvironmentHandle()),
          close: () => Promise.resolve(),
        },
        defaultEnvironmentRef: 'test',
        environmentGrant: { isolation: 'none' },
        createTracing: () => ({ close: async () => undefined }),
      },
    };
    const history = Array.from({ length: 40 }, (_unused, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: String(index % 10).repeat(8),
    }));
    const runRequest: AgentRunRequest = {
      threadId: 'thr_budget',
      turnId: 'turn_budget',
      executionLocation: {
        environmentRef: 'test',
        workingDirectory: '/workspace',
      },
      selection: { mode: 'ask-before-changes', agent: 'primary' },
      history,
      input: 'new task',
      goal: null,
      permission: { rules: () => [], externalPaths: () => [] },
    };

    const built = await buildAgent(runRequest, dependencies);
    try {
      await built.engine.run({ messages: history, prompt: runRequest.input });
    } finally {
      await built.close();
    }

    expect(factoryContextWindow).toBe(59);
    expect(runtimeContextWindow).toBe(59);
    expect(requestSeen?.messages.length).toBeLessThan(history.length + 1);
  });
});
