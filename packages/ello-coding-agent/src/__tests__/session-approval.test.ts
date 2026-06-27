import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCodingAgentSession,
  loadCodingAgentConfig,
} from '../index.js';
import type { CodingAgentEvent } from '../session/types.js';

vi.mock('@ello/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ello/agent')>();

  return {
    ...actual,
    createAgent: vi.fn(() => ({
      ctx: {
        usageSnapshot: null,
      },
      toolsets: [],
      async enter() {},
      async exit() {},
      stream() {
        const stateMessages = [{ role: 'user' as const, content: 'read outside' }];
        return {
          state: {
            messages: stateMessages,
          },
          recoverableMessages: () => stateMessages,
          interrupt() {},
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'agent_start',
              runId: 'run-mock',
            } as const;
          },
          async result() {
            return {
              output: {
                approvals: [
                  {
                    toolCallId: 'call-outside',
                    toolName: 'read_file',
                    input: { path: '/tmp/outside-secret.txt' },
                  },
                ],
                calls: [],
              },
            };
          },
        };
      },
    })),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CodingAgentSession approval integration', () => {
  it('turns deferred tool output into a session approval request with policy risk', async () => {
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
      await session.submit('read outside', (event) => events.push(event));
      const approval = events.find((event) => event.type === 'approval_request');

      expect(approval).toMatchObject({
        type: 'approval_request',
        toolCallId: 'call-outside',
        toolName: 'read_file',
      });
      expect(approval?.risk).toContain('outside allowedPaths');
    } finally {
      await session.close();
    }
  });
});
