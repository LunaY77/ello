import type { ModelInput } from '@ello/agent';
import { describe, expect, it } from 'vitest';

import { prepareModelInputForRuntimeModel } from '../provider/transforms.js';
import type { RuntimeModel } from '../provider/types.js';

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
  it('OpenAI promptCacheKey 不包含 runId，并随 toolset fingerprint 变化', () => {
    const model = runtimeModel('openai');
    const first = prepareModelInputForRuntimeModel(
      model,
      modelInput(diagnostics),
      { promptProfile: 'coding', workspaceIdentity: '/workspace' },
    );
    const second = prepareModelInputForRuntimeModel(
      model,
      modelInput({ ...diagnostics, toolsetFingerprint: 'x'.repeat(64) }),
      { promptProfile: 'coding', workspaceIdentity: '/workspace' },
    );

    const firstKey = readPromptCacheKey(first);
    expect(firstKey).toHaveLength(64);
    expect(firstKey).not.toContain('run');
    expect(readPromptCacheKey(second)).not.toBe(firstKey);
  });

  it('Anthropic 把稳定 system 放在 cache breakpoint 前，skill 放在后面', () => {
    const input = modelInput(diagnostics, {
      system:
        'stable prefix\n\n<skill-context id="skills:active" title="Active skills">\n- review\n</skill-context>\n\nstable suffix',
    });
    const transformed = prepareModelInputForRuntimeModel(
      runtimeModel('anthropic'),
      input,
      { promptProfile: 'coding', workspaceIdentity: '/workspace' },
    );

    expect(transformed).not.toHaveProperty('system');
    expect(transformed.messages[0]).toMatchObject({
      role: 'system',
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    });
    expect(JSON.stringify(transformed.messages[0])).not.toContain(
      'skill-context',
    );
    expect(JSON.stringify(transformed.messages[1])).toContain('skill-context');
  });
});

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

function runtimeModel(kind: 'openai' | 'anthropic'): RuntimeModel {
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
