import { describe, expect, it } from 'vitest';

import type { ModelCatalogEntry } from '../../src/api/protocol-types.js';
import { buildModelCatalogOptions } from '../../src/tui/model-selectors.js';

function model(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: 'benchmark-pro',
    name: 'benchmark-pro',
    title: 'Benchmark Pro',
    enabled: true,
    metadata: { protocol: 'openai', apiModel: 'gpt-5.5' },
    ...overrides,
  };
}

describe('模型选择项', () => {
  it('标记两个全局模型引用', () => {
    expect(
      buildModelCatalogOptions(
        [
          model(),
          model({
            id: 'benchmark-flash',
            name: 'benchmark-flash',
            title: 'Benchmark Flash',
          }),
        ],
        { primaryModel: 'benchmark-pro', auxiliaryModel: 'benchmark-flash' },
      ),
    ).toEqual([
      { label: 'Benchmark Pro [primary]', value: 'benchmark-pro' },
      { label: 'Benchmark Flash [auxiliary]', value: 'benchmark-flash' },
    ]);
  });

  it('两个引用相同时在同一目录项上同时标记', () => {
    expect(
      buildModelCatalogOptions([model()], {
        primaryModel: 'benchmark-pro',
        auxiliaryModel: 'benchmark-pro',
      }),
    ).toEqual([
      {
        label: 'Benchmark Pro [primary] [auxiliary]',
        value: 'benchmark-pro',
      },
    ]);
  });
});
