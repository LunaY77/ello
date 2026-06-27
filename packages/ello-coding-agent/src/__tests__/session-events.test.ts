import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCodingAgentSession,
  loadCodingAgentConfig,
} from '../index.js';
import type { CodingAgentEvent } from '../session/types.js';

describe('CodingAgentSession event integration', () => {
  it('creates a session and exposes product-layer events', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ello-coding-agent-cwd-'));
    const sessionDir = await mkdtemp(path.join(tmpdir(), 'ello-coding-agent-sessions-'));
    const config = await loadCodingAgentConfig({
      cwd,
      sessionDir,
      allowedPaths: [cwd],
      tui: false,
      json: true,
      approvalMode: 'on-request',
    });
    const session = await createCodingAgentSession(config);
    const events: CodingAgentEvent[] = [];

    try {
      session.emit({ type: 'diagnostic', level: 'info', message: 'ready' });
      for await (const event of session.events()) {
        events.push(event);
        if (event.type === 'diagnostic') {
          break;
        }
      }
      expect(events.some((event) => event.type === 'diagnostic')).toBe(true);
    } finally {
      await session.close();
    }
  });
});
