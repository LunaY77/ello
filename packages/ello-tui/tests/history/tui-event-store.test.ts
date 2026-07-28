import { describe, expect, it } from 'vitest';

import type {
  ServerNotification,
  ThreadItem,
  Turn,
} from '../../src/api/protocol-types.js';
import {
  createFileChange,
  fixtureSettings,
  fixtureSnapshot,
  fixtureThreadSummary,
  fixtureTimestamp,
} from '../../src/testing/protocol-fixtures.js';
import {
  createInitialTuiEventState,
  reduceTuiEvent,
} from '../../src/tui/store/tui-event-store.js';

describe('tui-event-store', () => {
  it('projects persisted snapshot history and active items', () => {
    const turn = turnFixture({
      id: 'turn-1',
      status: 'inProgress',
      items: [
        userItem('user-1', 'inspect the parser'),
        agentItem('agent-1', 'I am checking', 'inProgress'),
        commandItem('command-1', 'rg parser', 'inProgress'),
      ],
    });
    const state = createInitialTuiEventState(
      fixtureSnapshot({
        turns: [turn],
        seq: 3,
      }),
    );

    expect(state.history.map((entry) => entry.kind)).toEqual([
      'session_header',
      'user',
    ]);
    expect(state.live.assistantText).toBe('I am checking');
    expect(state.live.runningTools.get('command-1')?.status).toBe('running');
    expect(state.activeTurnId).toBe('turn-1');
    expect(state.status).toBe('idle');
  });

  it('projects turn and item lifecycle notifications into live and committed state', () => {
    let state = createInitialTuiEventState(fixtureSnapshot());
    const turn = turnFixture({ id: 'turn-1', status: 'inProgress', items: [] });
    const turnStarted = notification('turn/started', 1, {
      turnId: turn.id,
      turn,
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: turnStarted,
    });
    expect(state.status).toBe('idle');
    expect(state.activeTurnId).toBe('turn-1');

    const item = agentItem('agent-1', '', 'inProgress');
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/started', 2, {
        turnId: turn.id,
        itemId: item.id,
        item,
      }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/agentMessage/delta', 3, {
        turnId: turn.id,
        itemId: item.id,
        delta: 'Hello',
      }),
    });
    expect(state.live.assistantText).toBe('Hello');

    const completedItem = {
      ...item,
      text: 'Hello world',
      status: 'completed' as const,
    };
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/completed', 4, {
        turnId: turn.id,
        itemId: item.id,
        item: completedItem,
      }),
    });
    expect(state.live.assistantText).toBe('');
    expect(state.history.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'Hello world',
    });

    const completedTurn = {
      ...turn,
      items: [completedItem],
      status: 'completed' as const,
      completedAt: '2026-07-18T00:00:05.000Z',
    };
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('turn/completed', 5, {
        turnId: turn.id,
        turn: completedTurn,
      }),
    });
    expect(state.activeTurnId).toBeUndefined();
    expect(state.history.at(-1)).toMatchObject({
      kind: 'separator',
      text: 'Worked for 5s',
    });
  });

  it('projects command output deltas and completed tool cards', () => {
    const turn = turnFixture({ id: 'turn-1', status: 'inProgress', items: [] });
    const item = commandItem('command-1', 'pnpm test', 'inProgress');
    let state = createInitialTuiEventState(fixtureSnapshot());
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('turn/started', 1, { turnId: turn.id, turn }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/started', 2, {
        turnId: turn.id,
        itemId: item.id,
        item,
      }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/commandExecution/outputDelta', 3, {
        turnId: turn.id,
        itemId: item.id,
        stream: 'stdout',
        delta: 'pass\n',
      }),
    });
    expect(state.live.runningTools.get(item.id)?.output).toMatchObject({
      output: 'pass\n',
    });

    const completed = {
      ...item,
      outputPreview: 'pass\n',
      status: 'completed' as const,
      exitCode: 0,
    };
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/completed', 4, {
        turnId: turn.id,
        itemId: item.id,
        item: completed,
      }),
    });
    expect(state.live.runningTools.has(item.id)).toBe(false);
    expect(state.history.at(-1)).toMatchObject({ kind: 'tool', id: item.id });
  });

  it('projects reasoning deltas into live state and committed history', () => {
    const turn = turnFixture({ id: 'turn-1', status: 'inProgress', items: [] });
    const item: Extract<ThreadItem, { type: 'reasoning' }> = {
      id: 'reasoning-1',
      turnId: turn.id,
      type: 'reasoning',
      summary: '',
      status: 'inProgress',
      createdAt: fixtureTimestamp,
    };
    let state = createInitialTuiEventState(fixtureSnapshot());
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('turn/started', 1, { turnId: turn.id, turn }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/started', 2, {
        turnId: turn.id,
        itemId: item.id,
        item,
      }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/reasoning/delta', 3, {
        turnId: turn.id,
        itemId: item.id,
        delta: 'checking context',
      }),
    });
    expect(state.live.reasoningText).toBe('checking context');

    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/completed', 4, {
        turnId: turn.id,
        itemId: item.id,
        item: {
          ...item,
          summary: 'checking context',
          status: 'completed',
        },
      }),
    });
    expect(state.live.reasoningText).toBe('');
    expect(state.history.at(-1)).toMatchObject({
      kind: 'reasoning',
      text: 'checking context',
    });
  });

  it('keeps server requests pending until an explicit resolution', () => {
    const request = {
      id: 'request-1',
      method: 'item/tool/requestUserInput' as const,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
        reason: 'Need a choice',
        questions: [
          {
            id: 'choice',
            header: 'Choose',
            question: 'Which option?',
            multiple: false,
            options: [{ label: 'A', description: 'first' }],
          },
        ],
      },
      respond: async () => {},
      reject: async () => {},
    };
    let state = createInitialTuiEventState(fixtureSnapshot());
    state = reduceTuiEvent(state, { type: 'serverRequest', request });
    expect(state.pendingRequest?.id).toBe(request.id);
    state = reduceTuiEvent(state, {
      type: 'interaction.resolved',
      requestId: request.id,
      resolution: {
        status: 'submitted',
        answers: [{ questionId: 'choice', selected: ['A'] }],
      },
    });
    expect(state.pendingRequest).toBeUndefined();
    expect(state.history.at(-1)).toMatchObject({
      kind: 'user_input',
      id: `user-input-${request.id}`,
    });
  });

  it('updates settings, goal, plan, usage, and compaction state', () => {
    const goal = {
      id: 'goal-1',
      objective: 'ship refactor',
      status: 'active' as const,
      tokensUsed: 0,
      createdAt: fixtureTimestamp,
      updatedAt: fixtureTimestamp,
    };
    const plan = {
      threadId: 'thread-1',
      status: 'draft' as const,
      contentHash: 'hash-1',
      content: '- inspect',
      path: '/workspace/PLAN.md',
      updatedAt: fixtureTimestamp,
    };
    let state = createInitialTuiEventState(fixtureSnapshot());
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('thread/settings/updated', 1, {
        settings: fixtureSettings({ mode: 'plan', agent: 'build' }),
      }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('thread/goal/updated', 2, { goal }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('thread/plan/updated', 3, { plan }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('thread/tokenUsage/updated', 4, {
        usage: {
          requests: 1,
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          toolCalls: 1,
        },
      }),
    });
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('thread/compaction/updated', 5, {
        turnId: 'turn-1',
        summary: 'kept recent context',
        firstKeptSeq: 4,
        tokensBefore: 100,
      }),
    });

    expect(state.settings.mode).toBe('plan');
    expect(state.settings.agent).toBe('build');
    expect(state.goal).toEqual(goal);
    expect(state.snapshot.plan).toEqual(plan);
    expect(state.usage.outputTokens).toBe(3);
    expect(state.history.some((entry) => entry.id === 'compaction-5')).toBe(
      false,
    );
  });

  it('replaces automatic compaction progress with the complete checkpoint', () => {
    let state = createInitialTuiEventState(
      fixtureSnapshot({
        turns: [turnFixture({ id: 'turn-1', status: 'inProgress', items: [] })],
      }),
    );
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/started', 1, {
        turnId: 'turn-1',
        itemId: 'compact-1',
        item: {
          type: 'contextCompaction',
          id: 'compact-1',
          turnId: 'turn-1',
          createdAt: fixtureTimestamp,
          summary: 'Compacting 42 messages…',
          tokensBefore: 120_000,
          status: 'inProgress',
        },
      }),
    });

    expect(state.live.compactionText).toBe('Compacting 42 messages…');
    expect(state.history).toHaveLength(1);

    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/completed', 2, {
        turnId: 'turn-1',
        itemId: 'compact-1',
        item: {
          type: 'contextCompaction',
          id: 'compact-1',
          turnId: 'turn-1',
          createdAt: fixtureTimestamp,
          summary: '## Goal\nKeep the automatic checkpoint.',
          tokensBefore: 120_000,
          beforeMessageCount: 42,
          afterMessageCount: 8,
          keptMessageCount: 7,
          status: 'completed',
        },
      }),
    });

    expect(state.live.compactionText).toBe('');
    expect(state.history.at(-1)).toEqual({
      kind: 'compaction',
      id: 'compact-1',
      summary: '## Goal\nKeep the automatic checkpoint.',
      tokensBefore: 120_000,
      beforeMessageCount: 42,
      afterMessageCount: 8,
      keptMessageCount: 7,
    });
  });

  it('replaces manual compaction progress with the complete checkpoint', () => {
    let state = createInitialTuiEventState(fixtureSnapshot());
    state = reduceTuiEvent(state, { type: 'ui.compaction.started' });

    expect(state.live.compactionText).toBe('Compacting context…');
    expect(state.history).toHaveLength(1);

    state = reduceTuiEvent(state, {
      type: 'ui.compaction.completed',
      report: {
        id: 'compaction-7',
        summary: '## Goal\nKeep the compact checkpoint.',
        tokensBefore: 4_096,
        beforeMessageCount: 12,
        afterMessageCount: 3,
        keptMessageCount: 2,
      },
    });

    expect(state.live.compactionText).toBe('');
    expect(state.history.at(-1)).toEqual({
      kind: 'compaction',
      id: 'compaction-7',
      summary: '## Goal\nKeep the compact checkpoint.',
      tokensBefore: 4_096,
      beforeMessageCount: 12,
      afterMessageCount: 3,
      keptMessageCount: 2,
    });
  });

  it('handles UI messages, queued steering, stale markers, and snapshot replacement', () => {
    let state = createInitialTuiEventState(fixtureSnapshot());
    state = reduceTuiEvent(state, { type: 'ui.message', text: 'connected' });
    state = reduceTuiEvent(state, {
      type: 'steer.queued',
      steerId: 'steer_focus',
      text: 'focus tests',
    });
    state = reduceTuiEvent(state, {
      type: 'stale',
      expectedSeq: 1,
      receivedSeq: 4,
    });
    expect(state.history.at(-1)).toMatchObject({
      kind: 'system',
      text: 'connected',
    });
    expect(state.pendingSteers).toEqual([
      { steerId: 'steer_focus', text: 'focus tests' },
    ]);
    expect(state.stale).toBe(true);

    const replacement = fixtureSnapshot({
      seq: 10,
      thread: fixtureThreadSummary({ name: 'replacement' }),
    });
    state = reduceTuiEvent(state, { type: 'snapshot', snapshot: replacement });
    expect(state.snapshot.thread.name).toBe('replacement');
    expect(state.historyResetKey).toBe(1);
    expect(state.stale).toBe(false);
  });

  it('moves only the consumed duplicate steer from pending into history', () => {
    const turn = turnFixture({ id: 'turn-1', status: 'inProgress', items: [] });
    let state = createInitialTuiEventState(
      fixtureSnapshot({ turns: [turn], seq: 1 }),
    );
    state = reduceTuiEvent(state, {
      type: 'steer.queued',
      steerId: 'steer_first',
      text: 'focus tests',
    });
    state = reduceTuiEvent(state, {
      type: 'steer.queued',
      steerId: 'steer_second',
      text: 'focus tests',
    });
    const item = {
      ...userItem('user-steer-first', 'focus tests'),
      steerId: 'steer_first',
    };

    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/started', 2, {
        turnId: turn.id,
        itemId: item.id,
        item,
      }),
    });
    expect(state.pendingSteers).toHaveLength(2);
    state = reduceTuiEvent(state, {
      type: 'notification',
      notification: notification('item/completed', 3, {
        turnId: turn.id,
        itemId: item.id,
        item,
      }),
    });

    expect(state.pendingSteers).toEqual([
      { steerId: 'steer_second', text: 'focus tests' },
    ]);
    expect(state.history.at(-1)).toMatchObject({
      kind: 'user',
      text: 'focus tests',
    });

    state = reduceTuiEvent(state, {
      type: 'steer.failed',
      steerId: 'steer_second',
    });
    expect(state.pendingSteers).toEqual([]);
  });

  it('replays structured file changes instead of raw event payloads', () => {
    const item = {
      id: 'file-1',
      turnId: 'turn-1',
      type: 'fileChange' as const,
      changes: [createFileChange('src/a.ts', 'old\n', 'new\n')],
      status: 'completed' as const,
      createdAt: fixtureTimestamp,
    };
    const state = createInitialTuiEventState(
      fixtureSnapshot({
        turns: [
          turnFixture({
            id: 'turn-1',
            status: 'completed',
            items: [userItem('user-1', 'edit'), item],
            completedAt: fixtureTimestamp,
          }),
        ],
      }),
    );
    expect(state.history).toHaveLength(4);
    expect(state.history.at(-2)).toMatchObject({ kind: 'tool', id: item.id });
    expect(
      state.history.some(
        (entry) => entry.kind === 'diagnostic' && entry.text.includes('raw'),
      ),
    ).toBe(false);
  });

  it('replays a manual compact checkpoint after its completed turn separator', () => {
    const state = createInitialTuiEventState(
      fixtureSnapshot({
        turns: [
          turnFixture({
            id: 'turn-1',
            status: 'completed',
            items: [
              userItem('user-1', 'finish the task'),
              {
                id: 'compaction-7',
                turnId: 'turn-1',
                type: 'contextCompaction',
                summary: '## Goal\nPreserve the checkpoint.',
                tokensBefore: 4_096,
                beforeMessageCount: 12,
                afterMessageCount: 3,
                keptMessageCount: 2,
                status: 'completed',
                createdAt: '2026-07-18T00:00:06.000Z',
              },
            ],
            completedAt: '2026-07-18T00:00:05.000Z',
          }),
        ],
      }),
    );

    expect(state.history.map((entry) => entry.kind)).toEqual([
      'session_header',
      'user',
      'separator',
      'compaction',
    ]);
    expect(state.history.at(-1)).toMatchObject({
      kind: 'compaction',
      summary: '## Goal\nPreserve the checkpoint.',
    });
  });

  it('replays the persisted error from a failed tool call', () => {
    const item: Extract<ThreadItem, { type: 'toolCall' }> = {
      id: 'glob-1',
      turnId: 'turn-1',
      type: 'toolCall',
      toolName: 'glob',
      headline: 'Glob packages',
      status: 'failed',
      error: 'Path not allowed: /outside/packages',
      metadata: {
        input: { filePath: '/outside/packages', pattern: '**/*context*' },
      },
      createdAt: fixtureTimestamp,
    };
    const state = createInitialTuiEventState(
      fixtureSnapshot({
        turns: [
          turnFixture({
            id: 'turn-1',
            status: 'failed',
            items: [item],
            completedAt: fixtureTimestamp,
          }),
        ],
      }),
    );

    expect(state.history.at(-2)).toMatchObject({
      kind: 'tool',
      tool: {
        status: 'fail',
        error: { message: 'Path not allowed: /outside/packages' },
      },
    });
  });
});

function turnFixture(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-1',
    threadId: 'thread-1',
    status: 'completed',
    items: [],
    startedAt: fixtureTimestamp,
    ...overrides,
  };
}

function userItem(
  id: string,
  text: string,
): Extract<ThreadItem, { type: 'userMessage' }> {
  return {
    id,
    turnId: 'turn-1',
    type: 'userMessage',
    text,
    createdAt: fixtureTimestamp,
  };
}

function agentItem(
  id: string,
  text: string,
  status: Extract<ThreadItem, { type: 'agentMessage' }>['status'],
): Extract<ThreadItem, { type: 'agentMessage' }> {
  return {
    id,
    turnId: 'turn-1',
    type: 'agentMessage',
    text,
    phase: 'commentary',
    status,
    createdAt: fixtureTimestamp,
  };
}

function commandItem(
  id: string,
  command: string,
  status: Extract<ThreadItem, { type: 'commandExecution' }>['status'],
): Extract<ThreadItem, { type: 'commandExecution' }> {
  return {
    id,
    turnId: 'turn-1',
    type: 'commandExecution',
    command,
    cwd: '/workspace',
    status,
    createdAt: fixtureTimestamp,
  };
}

function notification<M extends ServerNotification['method']>(
  method: M,
  seq: number,
  params: Omit<
    Extract<ServerNotification, { method: M }>['params'],
    'threadId' | 'seq'
  >,
): Extract<ServerNotification, { method: M }> {
  return {
    method,
    params: { threadId: 'thread-1', seq, ...params },
  } as unknown as Extract<ServerNotification, { method: M }>;
}
