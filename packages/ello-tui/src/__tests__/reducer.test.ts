import type { CodingAgentConfig } from '@ello/coding-agent';
import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  suggestSlashCommands,
  tuiReducer,
} from '../index.js';

const config: CodingAgentConfig = {
  model: 'openai-chat:gpt-4o-mini',
  modelCandidates: ['openai-chat:gpt-4o-mini', 'openai-chat:gpt-4.1'],
  baseUrl: null,
  cwd: '/repo',
  allowedPaths: ['/repo'],
  sessionDir: '/tmp/sessions',
  sessionId: 's1',
  approvalMode: 'on-request',
  permissionRules: [],
  mcpConfigPath: null,
  systemPromptProfile: 'coding',
  theme: 'default',
  tui: true,
  json: false,
};

describe('tuiReducer', () => {
  it('accumulates assistant streaming text', () => {
    const state = createInitialState(config);
    const first = tuiReducer(state, {
      type: 'event',
      event: {
        type: 'core_event',
        event: {
          type: 'message_delta',
          delta: { type: 'text', text: 'hel' },
          partial: { role: 'assistant', content: 'hel' },
        },
      },
    });
    const second = tuiReducer(first, {
      type: 'event',
      event: {
        type: 'core_event',
        event: {
          type: 'message_delta',
          delta: { type: 'text', text: 'lo' },
          partial: { role: 'assistant', content: 'hello' },
        },
      },
    });

    expect(second.transcript.at(-1)).toMatchObject({ role: 'assistant', text: 'hello' });
  });

  it('tracks approval panel state', () => {
    const state = tuiReducer(createInitialState(config), {
      type: 'event',
      event: {
        type: 'approval_request',
        toolCallId: 'call_1',
        toolName: 'shell_exec',
        input: { command: 'git status' },
        risk: 'shell',
      },
    });

    expect(state.status).toBe('approval');
    expect(state.pendingApproval?.toolCallId).toBe('call_1');
    expect(tuiReducer(state, { type: 'approval_cleared' }).pendingApproval).toBeNull();
  });

  it('navigates command history', () => {
    const pushed = tuiReducer(createInitialState(config), {
      type: 'history_push',
      value: 'hello',
    });
    const prev = tuiReducer(pushed, { type: 'history_prev' });
    const next = tuiReducer(prev, { type: 'history_next' });

    expect(prev.historyIndex).toBe(0);
    expect(next.historyIndex).toBeNull();
  });

  it('renders usage snapshots with cache and tool totals', () => {
    const state = tuiReducer(createInitialState(config), {
      type: 'event',
      event: {
        type: 'usage_snapshot',
        runId: 'run_1',
        totalUsage: {
          requests: 2,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          toolCalls: 1,
        },
        modelUsage: {},
        agentUsage: {},
      },
    });

    expect(state.usageText).toBe('usage 38');
    expect(state.usageTotals).toBe('2 req / 10 in / 20 out / 7 cache / 1 tool');
  });

  it('navigates the model picker list', () => {
    const state = createInitialState(config);
    const next = tuiReducer(state, { type: 'model_next' });
    const prev = tuiReducer(next, { type: 'model_prev' });

    expect(next.modelIndex).toBe(1);
    expect(prev.modelIndex).toBe(0);
  });

  it('tracks tool card duration across start and finish events', () => {
    const started = tuiReducer(createInitialState(config), {
      type: 'event',
      event: {
        type: 'tool_display',
        status: 'started',
        toolCallId: 'tool_1',
        toolName: 'read_file',
        args: { path: 'README.md' },
        startedAt: '2026-06-27T00:00:00.000Z',
      },
    });
    const finished = tuiReducer(started, {
      type: 'event',
      event: {
        type: 'tool_display',
        status: 'finished',
        toolCallId: 'tool_1',
        toolName: 'read_file',
        result: 'ok',
        durationMs: 42,
        finishedAt: '2026-06-27T00:00:00.042Z',
      },
    });

    expect(finished.tools.tool_1).toMatchObject({
      status: 'finished',
      args: { path: 'README.md' },
      result: 'ok',
      startedAt: '2026-06-27T00:00:00.000Z',
      finishedAt: '2026-06-27T00:00:00.042Z',
      durationMs: 42,
    });
  });

  it('tracks exit confirmation state', () => {
    const pending = tuiReducer(createInitialState(config), {
      type: 'exit_pending',
      value: true,
    });

    expect(pending.exitPending).toBe(true);
    expect(tuiReducer(pending, { type: 'exit_pending', value: false }).exitPending).toBe(false);
  });

  it('loads sessions without opening the picker overlay', () => {
    const state = tuiReducer(createInitialState(config), {
      type: 'sessions',
      sessions: [
        {
          sessionId: 's2',
          filePath: '/tmp/sessions/s2.jsonl',
          createdAt: null,
          updatedAt: null,
          leafId: null,
          entryCount: 0,
          branchOf: null,
        },
      ],
    });

    expect(state.sessions).toHaveLength(1);
    expect(state.overlay).toBeNull();
  });

  it('suggests matching slash commands', () => {
    expect(suggestSlashCommands('/co')).toEqual(['/compact', '/config']);
  });
});
