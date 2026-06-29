import { describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config.js';
import { codingSubagents } from '../subagents.js';

describe('coding subagents', () => {
  it('registers the explorer subagent name used by the system prompt', async () => {
    const config = await loadCodingAgentConfig({ model: 'fake:test' });
    const names = codingSubagents(config).map((item) => item.name);

    expect(names).toContain('explorer');
    expect(names).toContain('explore');
    expect(names).toContain('reviewer');
  });
});
