import { describe, expect, it } from 'vitest';

import type {
  ModelCatalogEntry,
  ProviderCatalogEntry,
} from '../../src/api/protocol-types.js';
import {
  buildModelCatalogOptions,
  buildProfileSelectorOptions,
} from '../../src/tui/model-selectors.js';

function model(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: 'openai/gpt-5',
    name: 'gpt-5',
    title: 'GPT-5',
    enabled: true,
    metadata: { provider: 'openai' },
    ...overrides,
  };
}

function provider(
  overrides: Partial<ProviderCatalogEntry> = {},
): ProviderCatalogEntry {
  return {
    id: 'openai',
    name: 'OpenAI',
    enabled: true,
    metadata: {},
    ...overrides,
  };
}

describe('模型与 profile 选择项', () => {
  it('用不可选分组展示 profile，并标记当前 profile', () => {
    const options = buildProfileSelectorOptions(
      [
        { id: 'main', name: 'main' },
        { id: 'reviewer', name: 'reviewer' },
      ],
      'main',
    );

    expect(options).toEqual([
      { label: 'Profiles', value: 'group:Profiles', disabled: true },
      { label: 'main [active]', value: 'main' },
      { label: 'reviewer', value: 'reviewer' },
    ]);
  });

  it('按 provider 分组，并使用协议中的 provider 展示名称', () => {
    const options = buildModelCatalogOptions(
      [
        model(),
        model({
          id: 'anthropic/claude',
          name: 'claude',
          title: 'Claude',
          metadata: { provider: 'anthropic' },
        }),
      ],
      [provider(), provider({ id: 'anthropic', name: 'Anthropic' })],
    );

    expect(options).toEqual([
      { label: 'OpenAI', value: 'group:OpenAI', disabled: true },
      { label: '  GPT-5', value: 'openai/gpt-5' },
      { label: 'Anthropic', value: 'group:Anthropic', disabled: true },
      { label: '  Claude', value: 'anthropic/claude' },
    ]);
  });

  it('provider 未登记时回退到 provider id，缺少标题时回退到模型名', () => {
    const options = buildModelCatalogOptions([
      model({
        id: 'local/model',
        name: 'local-model',
        title: undefined,
        metadata: { provider: 'local' },
      }),
      model({
        id: 'other/model',
        name: 'other-model',
        title: undefined,
        metadata: {},
      }),
    ]);

    expect(options).toContainEqual({
      label: 'local',
      value: 'group:local',
      disabled: true,
    });
    expect(options).toContainEqual({
      label: '  local-model',
      value: 'local/model',
    });
    expect(options).toContainEqual({
      label: 'Models',
      value: 'group:Models',
      disabled: true,
    });
  });

  it('空目录不产生不可操作的空分组', () => {
    expect(buildModelCatalogOptions([])).toEqual([]);
  });
});
