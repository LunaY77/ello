/**
 * 验证 runtime model 的输入预算、模型设置和 provider cache 转换契约。
 */
import { describe, expect, it } from 'vitest';

import {
  splitSystemCacheSegments,
  wrapDynamicSystemContent,
  type ModelInput,
} from '../../src/features/agent/engine/index.js';
import type { ContextConfig } from '../../src/features/config/index.js';
import {
  modelInputBudgetFromRuntimeModel,
  modelSettingsFromRuntimeModel,
  prepareModelInputForRuntimeModel,
} from '../../src/features/model/providers/catalog/transforms.js';
import type { RuntimeModel } from '../../src/features/model/providers/catalog/types.js';

const diagnostics = {
  systemSections: 1,
  messageCount: 1,
  hasProviderOptions: false,
  appliedMessageTransforms: [],
  systemFingerprint: 's'.repeat(64),
  toolsetFingerprint: 't'.repeat(64),
  messagePrefixFingerprint: 'm'.repeat(64),
  compactionBoundary: false,
};

describe('provider cache transforms', () => {
  it('caps the model-input budget at the selected model context window', () => {
    const model = {
      ...runtimeModel('anthropic'),
      contextWindow: 64_000,
      maxOutputTokens: 8_000,
    };
    const context = {
      max_input_tokens: 160_000,
      reserved_output_tokens: 8_000,
    } as ContextConfig;

    expect(modelInputBudgetFromRuntimeModel(model, context)).toEqual({
      maxInputTokens: 64_000,
      reservedOutputTokens: 8_000,
    });
    expect(
      modelInputBudgetFromRuntimeModel(
        { ...model, maxOutputTokens: 32_000 },
        context,
      ),
    ).toEqual({
      maxInputTokens: 40_000,
      reservedOutputTokens: 8_000,
    });
  });

  it('allows dynamic cache sections only after a stable instruction prefix', () => {
    const instructions = [
      'stable prefix',
      wrapDynamicSystemContent('active skill'),
      wrapDynamicSystemContent('memory'),
    ].join('\n\n');

    expect(splitSystemCacheSegments(instructions)).toEqual({
      stable: 'stable prefix',
      dynamic: 'active skill\n\nmemory',
    });
    expect(() =>
      splitSystemCacheSegments(
        `stable prefix\n\n${wrapDynamicSystemContent('active skill')}\n\nstable suffix`,
      ),
    ).toThrow('Stable system content must not follow dynamic context.');
  });

  it('adds the OpenAI cache key from stable instructions and tool contract', () => {
    const model = runtimeModel('openai');
    const first = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics, {
        instructions: cacheInstructions('stable rule A', 'skill review'),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    const dynamicChanged = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics, {
        instructions: cacheInstructions('stable rule A', 'skill verify'),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    const instructionChanged = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics, {
        instructions: cacheInstructions('stable rule B', 'skill verify'),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );

    const firstKey = readPromptCacheKey(first);
    expect(firstKey).toHaveLength(64);
    expect(readPromptCacheKey(dynamicChanged)).toBe(firstKey);
    expect(readPromptCacheKey(instructionChanged)).not.toBe(firstKey);
  });

  it('does not apply official OpenAI prompt cache options to compatible models', () => {
    const transformed = prepareModelInputForRuntimeModel(
      runtimeModel('openai-compatible'),
      modelInput(diagnostics),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    expect(transformed.providerOptions).toBeUndefined();
  });

  it('does not turn generic reasoning effort into Anthropic extended thinking', () => {
    expect(modelSettingsFromRuntimeModel(runtimeModel('anthropic'))).toEqual({
      maxOutputTokens: 10_000,
    });
    expect(modelSettingsFromRuntimeModel(runtimeModel('openai'))).toEqual({
      maxOutputTokens: 10_000,
      reasoning: 'medium',
    });
  });

  it('puts Anthropic cache breakpoints in instructions, never conversation messages', () => {
    const transformed = prepareModelInputForRuntimeModel(
      runtimeModel('anthropic'),
      modelInput(diagnostics, {
        instructions: cacheInstructions('stable prefix', 'skill review'),
        messages: [
          { role: 'user', content: 'first instruction' },
          { role: 'assistant', content: 'first result' },
          { role: 'user', content: 'next instruction' },
        ],
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );

    expect(transformed.instructions).toEqual([
      expect.objectContaining({
        role: 'system',
        content: 'stable prefix',
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
        },
      }),
      expect.objectContaining({ role: 'system', content: 'skill review' }),
    ]);
    expect(transformed.messages).not.toContainEqual(
      expect.objectContaining({ role: 'system' }),
    );
    expect(transformed.messages.at(-1)).toMatchObject({
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } },
      },
    });
    expect(cacheBreakpointLayout(transformed)).toEqual([[2, '5m']]);
  });

  it('anchors long conversations so the rolling breakpoint is not the only fallback', () => {
    expect(cacheBreakpointLayout(transformAnthropic(60))).toEqual([
      [19, '1h'],
      [39, '1h'],
      [59, '5m'],
    ]);
    // 锚点在一个 stride 内逐字节不动：61…80 条消息给出同一组 1h 断点，
    // 只有尾部断点前移。锚点每轮变化就等于没有回落层。
    expect(cacheBreakpointLayout(transformAnthropic(61))).toEqual([
      [39, '1h'],
      [59, '1h'],
      [60, '5m'],
    ]);
    expect(cacheBreakpointLayout(transformAnthropic(80))).toEqual([
      [39, '1h'],
      [59, '1h'],
      [79, '5m'],
    ]);
    // 越过下一个 stride 边界后，两个锚点整体前移一格。
    expect(cacheBreakpointLayout(transformAnthropic(81))).toEqual([
      [59, '1h'],
      [79, '1h'],
      [80, '5m'],
    ]);
  });

  it('never exceeds the Anthropic four-breakpoint budget', () => {
    for (const count of [1, 2, 20, 21, 40, 41, 199, 200, 501]) {
      const layout = cacheBreakpointLayout(transformAnthropic(count));
      expect(layout.length).toBeLessThanOrEqual(3);
      expect(layout.at(-1)?.[0]).toBe(count - 1);
      expect(new Set(layout.map(([index]) => index)).size).toBe(layout.length);
    }
  });
});

function transformAnthropic(messageCount: number): ModelInput {
  return prepareModelInputForRuntimeModel(
    runtimeModel('anthropic'),
    modelInput(diagnostics, {
      instructions: cacheInstructions('stable prefix', 'skill review'),
      messages: Array.from({ length: messageCount }, (_unused, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message ${String(index)}`,
      })),
    }),
    { promptProfile: 'coding', cwdIdentity: '/workspace' },
  );
}

function cacheBreakpointLayout(
  input: ModelInput,
): readonly (readonly [number, string])[] {
  return input.messages.flatMap((message, index) => {
    const anthropic = message.providerOptions?.anthropic;
    if (anthropic === undefined) return [];
    const cacheControl = (
      anthropic as { readonly cacheControl?: { readonly ttl?: unknown } }
    ).cacheControl;
    if (cacheControl === undefined) return [];
    if (typeof cacheControl.ttl !== 'string') {
      throw new Error(`Cache breakpoint at ${String(index)} has no ttl.`);
    }
    return [[index, cacheControl.ttl] as const];
  });
}

function cacheInstructions(stable: string, dynamic: string): string {
  return `${stable}\n\n${wrapDynamicSystemContent(dynamic)}`;
}

function modelInput(
  inputDiagnostics: typeof diagnostics,
  overrides: Partial<ModelInput> = {},
): ModelInput {
  return {
    instructions: 'stable system',
    messages: [{ role: 'user', content: 'hello' }],
    tools: {},
    diagnostics: inputDiagnostics,
    ...overrides,
  };
}

function runtimeModel(
  protocol: 'openai' | 'anthropic' | 'openai-compatible',
): RuntimeModel {
  return {
    name: `${protocol}-model`,
    protocol,
    ...(protocol === 'anthropic'
      ? { authScheme: 'api-key' as const }
      : { endpoint: 'responses' as const }),
    apiModel: 'model-a',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnv: 'TEST_API_KEY',
    apiKey: 'test-key',
    contextWindow: 100_000,
    maxOutputTokens: 10_000,
    reasoningEffort: 'medium',
  };
}

function readPromptCacheKey(input: ModelInput): string {
  const openai = input.providerOptions?.openai;
  if (typeof openai !== 'object' || openai === null) {
    throw new Error('missing openai provider options');
  }
  const key = (openai as { readonly promptCacheKey?: unknown }).promptCacheKey;
  if (typeof key !== 'string') throw new Error('missing promptCacheKey');
  return key;
}
