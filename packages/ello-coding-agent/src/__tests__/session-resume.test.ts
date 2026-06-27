import { describe, expect, it } from 'vitest';

import {
  createCodingAgentSession,
  loadCodingAgentConfig,
} from '../index.js';

describe('CodingAgentSession resumeInterruptedRun', () => {
  it('is present on the session controller surface', async () => {
    const config = await loadCodingAgentConfig({ cwd: process.cwd(), tui: false, json: true });
    const session = await createCodingAgentSession(config);
    expect(typeof session.resumeInterruptedRun).toBe('function');
    await session.close();
  });
});
