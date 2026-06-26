import { describe, expect, it, vi } from 'vitest';

import {
  applyModelWrapper,
  applySubagentWrapper,
  createAgent,
} from '../index.js';

describe('applyModelWrapper', () => {
  it('returns model when wrapper is null', async () => {
    const model = createAgent().model;

    await expect(applyModelWrapper(null, model, 'main', {})).resolves.toBe(
      model,
    );
  });

  it('applies sync and async wrappers', async () => {
    const model = createAgent().model;
    const wrapped = createAgent({
      modelName: 'openai-chat:gpt-4.1-mini',
    }).model;

    await expect(
      applyModelWrapper(() => wrapped, model, 'main', {}),
    ).resolves.toBe(wrapped);
    await expect(
      applyModelWrapper(async () => wrapped, model, 'main', {}),
    ).resolves.toBe(wrapped);
  });

  it('passes metadata', async () => {
    const model = createAgent().model;
    const wrapper = vi.fn((receivedModel) => receivedModel);
    const meta = { runId: 'test123', custom: 'value' };

    await applyModelWrapper(wrapper, model, 'my_agent', meta);

    expect(wrapper).toHaveBeenCalledWith(model, 'my_agent', meta);
  });
});

describe('applySubagentWrapper', () => {
  it('returns model when wrapper is null', async () => {
    const model = createAgent().model;

    await expect(
      applySubagentWrapper(null, model, 'main', 'sub', {}),
    ).resolves.toBe(model);
  });

  it('applies sync and async wrappers', async () => {
    const model = createAgent().model;
    const wrapped = createAgent({
      modelName: 'openai-chat:gpt-4.1-mini',
    }).model;

    await expect(
      applySubagentWrapper(() => wrapped, model, 'main', 'sub', {}),
    ).resolves.toBe(wrapped);
    await expect(
      applySubagentWrapper(async () => wrapped, model, 'main', 'sub', {}),
    ).resolves.toBe(wrapped);
  });
});
