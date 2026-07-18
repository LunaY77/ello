import { describe, expect, it } from 'vitest';

import {
  splitSystemCacheSegments,
  wrapDynamicSystemContent,
} from '../agent/context/cache-layout.js';
import type { ModelInput } from '../agent/engine/index.js';
import { prepareModelInputForRuntimeModel } from '../agent/providers/catalog/transforms.js';
import type { RuntimeModel } from '../agent/providers/catalog/types.js';

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
  it('cache layout 只允许稳定前缀后连续追加动态段', () => {
    const system = [
      'stable prefix',
      wrapDynamicSystemContent('active skill'),
      wrapDynamicSystemContent('memory'),
    ].join('\n\n');

    expect(splitSystemCacheSegments(system)).toEqual({
      stable: 'stable prefix',
      dynamic: 'active skill\n\nmemory',
    });
    expect(() =>
      splitSystemCacheSegments(
        `stable prefix\n\n${wrapDynamicSystemContent('active skill')}\n\nstable suffix`,
      ),
    ).toThrow('Stable system content must not follow dynamic context.');
  });

  it('OpenAI key 隔离稳定指令集，但不随动态 skill 变化', () => {
    const model = runtimeModel('openai');
    const first = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics, {
        system: cacheSystem('stable rule A', 'skill review'),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    const dynamicChanged = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics, {
        system: cacheSystem('stable rule A', 'skill verify'),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    const instructionChanged = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics, {
        system: cacheSystem('stable rule B', 'skill verify'),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    const historyGrew = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics, {
        system: cacheSystem('stable rule A', 'skill review'),
        messages: Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `message-${index}`,
        })),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );

    const firstKey = readPromptCacheKey(first);
    expect(firstKey).toHaveLength(64);
    expect(firstKey).not.toContain('run');
    expect(readPromptCacheKey(dynamicChanged)).toBe(firstKey);
    expect(readPromptCacheKey(historyGrew)).toBe(firstKey);
    expect(readPromptCacheKey(instructionChanged)).not.toBe(firstKey);
  });

  it('OpenAI key 随工具契约变化', () => {
    const model = runtimeModel('openai');
    const changedTools = prepareModelInputForRuntimeModel(
      model,
      modelInput({ ...diagnostics, toolsetFingerprint: 'x'.repeat(64) }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    const baseline = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    expect(readPromptCacheKey(changedTools)).not.toBe(
      readPromptCacheKey(baseline),
    );
  });

  it('Anthropic 缓存稳定 system/tool 前缀和长会话前沿', () => {
    const input = modelInput(diagnostics, {
      system: cacheSystem('stable prefix', 'skill review'),
      messages: [
        { role: 'user', content: 'first instruction' },
        { role: 'assistant', content: 'first result' },
        { role: 'user', content: 'next instruction' },
      ],
    });
    const transformed = prepareModelInputForRuntimeModel(
      runtimeModel('anthropic'),
      input,
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );

    expect(transformed).not.toHaveProperty('system');
    expect(transformed.messages[0]).toMatchObject({
      role: 'system',
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
    });
    expect(JSON.stringify(transformed.messages[0])).not.toContain(
      'skill review',
    );
    expect(JSON.stringify(transformed.messages[1])).toContain('skill review');
    expect(transformed.messages.at(-1)).toMatchObject({
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } },
      },
    });
  });

  it('Anthropic 动态上下文变化不改变稳定 cache 前缀', () => {
    const first = prepareModelInputForRuntimeModel(
      runtimeModel('anthropic'),
      modelInput(diagnostics, {
        system: cacheSystem('stable rule', 'skill review'),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );
    const second = prepareModelInputForRuntimeModel(
      runtimeModel('anthropic'),
      modelInput(diagnostics, {
        system: cacheSystem('stable rule', 'skill verify'),
      }),
      { promptProfile: 'coding', cwdIdentity: '/workspace' },
    );

    expect(first.messages[0]).toEqual(second.messages[0]);
  });
});

function cacheSystem(stable: string, dynamic: string): string {
  return `${stable}\n\n${wrapDynamicSystemContent(dynamic)}`;
}

function modelInput(
  inputDiagnostics: typeof diagnostics,
  overrides: Partial<ModelInput> = {},
): ModelInput {
  return {
    system: 'stable system',
    messages: [{ role: 'user', content: 'hello' }],
    tools: {},
    diagnostics: inputDiagnostics,
    ...overrides,
  };
}

function runtimeModel(
  kind: 'openai' | 'anthropic' | 'openai-compatible',
): RuntimeModel {
  return {
    ref: `${kind}/model-a`,
    providerId: kind,
    id: 'model-a',
    name: 'Model A',
    apiId: 'model-a',
    providerKind: kind,
    status: 'active',
    capabilities: {
      temperature: true,
      reasoning: true,
      toolCall: true,
      input: ['text'],
      output: ['text'],
    },
    limit: { context: 100_000, output: 10_000 },
    headers: {},
    options: {},
    variants: {},
  };
}

function readPromptCacheKey(input: ModelInput): string {
  const openai = input.providerOptions?.openai;
  if (typeof openai !== 'object' || openai === null) {
    throw new Error('missing openai provider options');
  }
  const key = (openai as { readonly promptCacheKey?: unknown }).promptCacheKey;
  if (typeof key !== 'string') {
    throw new Error('missing promptCacheKey');
  }
  return key;
}
