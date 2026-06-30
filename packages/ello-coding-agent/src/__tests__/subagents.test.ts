import { describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import { codingSubagents } from '../subagents/index.js';

describe('coding subagents', () => {
  it('registers the explorer subagent name used by the system prompt', async () => {
    const config = await loadCodingAgentConfig({ model: 'fake:test' });
    const subagents = await codingSubagents(config);
    const names = subagents.map((item) => item.name);

    expect(names).toContain('explorer');
    expect(names).toContain('reviewer');
    expect(
      subagents.find((item) => item.name === 'explorer')?.metadata,
    ).toMatchObject({
      source: 'bundled',
    });
  });
});
