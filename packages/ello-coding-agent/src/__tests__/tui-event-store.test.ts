import { describe, expect, it } from 'vitest';

import {
  initialTuiEventState,
  reduceTuiEvent,
} from '../tui/store/tui-event-store.js';

const runCompleted = {
  type: 'run.completed',
  runId: 'run-1',
  finishReason: 'stop',
  usage: {
    requests: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
  },
} as const;

describe('tui-event-store', () => {
  it('commits Plan mode changes and Plan task input to visible history', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'session.mode.changed',
      state: {
        mode: 'plan',
        previousMode: 'default',
        source: 'slash-command',
        changedAt: '2026-07-16T00:00:00.000Z',
      },
    });
    state = reduceTuiEvent(state, {
      type: 'plan.input.submitted',
      prompt: 'inspect the repository',
    });

    expect(state.mode.mode).toBe('plan');
    expect(state.history).toEqual([
      expect.objectContaining({ kind: 'system', text: 'mode: plan' }),
      expect.objectContaining({
        kind: 'user',
        text: 'inspect the repository',
      }),
    ]);
  });

  it('shows a validated goal objective as the real user submission', () => {
    const goal = {
      id: 'goal-1',
      objective: 'finish the implementation',
      status: 'active',
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      continuationTurns: 0,
      tokensUsed: 0,
      activeMs: 0,
      activeSince: '2026-07-10T00:00:00.000Z',
      blockerStreak: 0,
    } as const;

    const state = reduceTuiEvent(initialTuiEventState, {
      type: 'goal.created',
      goal,
    });

    expect(state.goal).toEqual(goal);
    expect(state.history.at(-1)).toMatchObject({
      kind: 'user',
      text: 'finish the implementation',
    });
  });

  it('accumulates assistant deltas and flushes on run.completed', () => {
    let state = initialTuiEventState;
    state = reduceTuiEvent(state, {
      type: 'message.started',
      messageId: 'm1',
      role: 'assistant',
    });
    state = reduceTuiEvent(state, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'Hel',
    });
    state = reduceTuiEvent(state, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'lo',
    });
    expect(state.live.assistantText).toBe('Hello');

    state = reduceTuiEvent(state, runCompleted);
    expect(state.live.assistantText).toBe('');
    expect(state.history.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'Hello',
    });
  });

  it('does not fabricate assistant output from the completion summary', () => {
    const state = reduceTuiEvent(initialTuiEventState, runCompleted);

    expect(state.history).toHaveLength(0);
  });

  it('trims assistant stream whitespace before committing history', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'message.delta',
      messageId: 'm1',
      text: '\n\nanswer\n\n',
    });
    state = reduceTuiEvent(state, runCompleted);

    expect(state.history.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'answer',
    });
  });

  it('does not append adjacent duplicate optimistic user input', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'user.input',
      text: 'hello',
    });
    state = reduceTuiEvent(state, {
      type: 'user.input',
      text: 'hello',
    });

    expect(state.history).toHaveLength(1);
    expect(state.history.at(-1)).toMatchObject({
      kind: 'user',
      text: 'hello',
    });
  });

  it('appends a completed run separator to committed history', () => {
    const state = reduceTuiEvent(initialTuiEventState, {
      type: 'run.worked',
      duration: '5m 24s',
    });

    expect(state.history.at(-1)).toMatchObject({
      kind: 'separator',
      text: 'Worked for 5m 24s',
    });
  });

  it('commits streamed output once at run completion', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'streamed answer',
    });
    state = reduceTuiEvent(state, runCompleted);

    expect(state.history).toHaveLength(1);
    expect(state.history.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'streamed answer',
    });
  });

  it('does not duplicate run.completed output after the assistant was already flushed', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'streamed answer',
    });
    state = reduceTuiEvent(state, {
      type: 'message.started',
      messageId: 'm2',
      role: 'assistant',
    });
    state = reduceTuiEvent(state, runCompleted);

    expect(state.history).toHaveLength(1);
    expect(state.history.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'streamed answer',
    });
  });

  it('flushes a live assistant segment when the next assistant message starts', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'intermediate note',
    });

    state = reduceTuiEvent(state, {
      type: 'message.started',
      messageId: 'm2',
      role: 'assistant',
    });

    expect(state.live.assistantText).toBe('');
    expect(state.history.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'intermediate note',
    });
  });

  it('does not replay historical assistant tool-call messages as raw json', () => {
    const state = reduceTuiEvent(initialTuiEventState, {
      type: 'session.history.loaded',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'read',
              input: { path: 'src/index.ts' },
            },
          ],
        },
      ] as never,
    });

    expect(state.history).toHaveLength(0);
  });

  it('moves a tool from running to committed history', () => {
    let state = initialTuiEventState;
    state = reduceTuiEvent(state, {
      type: 'tool.started',
      toolCallId: 't1',
      name: 'read',
      input: { path: 'a.ts' },
    });
    expect(state.live.runningTools.get('t1')?.status).toBe('running');

    state = reduceTuiEvent(state, {
      type: 'tool.completed',
      toolCallId: 't1',
      output: { totalLines: 3 },
    });
    expect(state.live.runningTools.has('t1')).toBe(false);
    expect(state.history.at(-1)).toMatchObject({ kind: 'tool' });
  });

  it('commits assistant preamble before the tool it introduces', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'I will read the file first.',
    });

    state = reduceTuiEvent(state, {
      type: 'tool.started',
      toolCallId: 't1',
      name: 'read',
      input: { path: 'a.ts' },
    });
    state = reduceTuiEvent(state, {
      type: 'tool.completed',
      toolCallId: 't1',
      output: { totalLines: 3 },
    });

    expect(state.live.assistantText).toBe('');
    expect(state.history.map((entry) => entry.kind)).toEqual([
      'assistant',
      'tool',
    ]);
    expect(state.history[0]).toMatchObject({
      kind: 'assistant',
      text: 'I will read the file first.',
    });
  });

  it('renders subagent runtime and nested tool activity', () => {
    let state = initialTuiEventState;
    state = reduceTuiEvent(state, {
      type: 'subagent.started',
      runId: 'task-1',
      agentName: 'explore',
      description: 'inspect config loader',
      background: false,
      startedAt: '2026-07-01T00:00:00.000Z',
    });
    state = reduceTuiEvent(state, {
      type: 'subagent.event',
      runId: 'task-1',
      event: {
        type: 'tool.started',
        toolCallId: 'read-1',
        name: 'read',
        input: { path: 'src/config.ts' },
      },
    });
    state = reduceTuiEvent(state, {
      type: 'subagent.event',
      runId: 'task-1',
      event: {
        type: 'tool.completed',
        toolCallId: 'read-1',
        output: 'ok',
      },
    });

    expect(state.live.runningSubagents.get('task-1')).toMatchObject({
      agentName: 'explore',
      tools: [{ id: 'read-1', status: 'ok' }],
    });

    state = reduceTuiEvent(state, {
      type: 'subagent.completed',
      runId: 'task-1',
      output: 'config loader summary',
      completedAt: '2026-07-01T00:00:02.000Z',
    });

    expect(state.live.runningSubagents.has('task-1')).toBe(false);
    expect(state.history.at(-1)).toMatchObject({
      kind: 'subagent',
      run: {
        runId: 'task-1',
        status: 'completed',
        output: 'config loader summary',
        tools: [{ id: 'read-1', status: 'ok' }],
      },
    });
  });

  it('tracks pending approval and clears it on status change', () => {
    let state = initialTuiEventState;
    state = reduceTuiEvent(state, {
      type: 'approval.pending',
      requestId: 'r1',
      toolName: 'write',
      input: {},
    });
    expect(state.status).toBe('awaiting_approval');
    expect(state.pendingApproval?.requestId).toBe('r1');

    state = reduceTuiEvent(state, { type: 'status', state: 'idle' });
    expect(state.pendingApproval).toBeUndefined();
  });

  it('seals a working tool when its approval is denied', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'tool.started',
      toolCallId: 'write-1',
      name: 'write',
      input: { path: 'note.txt' },
    });
    state = reduceTuiEvent(state, {
      type: 'tool.failed',
      toolCallId: 'write-1',
      error: { name: 'Error', message: "Tool 'write' was denied by the user." },
    });

    expect(state.live.runningTools.has('write-1')).toBe(false);
    expect(state.history.at(-1)).toMatchObject({
      kind: 'tool',
      tool: {
        id: 'write-1',
        status: 'fail',
        error: { message: "Tool 'write' was denied by the user." },
      },
    });
  });

  it('renders product messages into committed history', () => {
    const state = reduceTuiEvent(initialTuiEventState, {
      type: 'ui.message',
      text: 'Model switched to fake:test',
    });

    expect(state.history.at(-1)).toMatchObject({
      kind: 'system',
      text: 'Model switched to fake:test',
    });
  });

  it('keeps title and context source events out of visible history', () => {
    let state = initialTuiEventState;
    state = reduceTuiEvent(state, {
      type: 'session.title.updated',
      sessionId: 's1',
      title: 'Hello World',
    });
    state = reduceTuiEvent(state, {
      type: 'context.source.loaded',
      source: {
        id: 'runtime',
        type: 'environment',
        title: 'Runtime environment',
        priority: 1,
        content: 'cwd=/repo',
      },
    });
    state = reduceTuiEvent(state, {
      type: 'approval.required',
      runId: 'run-1',
      item: {
        kind: 'approval',
        toolCallId: 'call-1',
        toolName: 'delegate_to_subagent',
      },
    });

    expect(state.history).toHaveLength(0);
  });

  it('replays historical tool calls as compact tool cards instead of raw JSON', () => {
    const state = reduceTuiEvent(initialTuiEventState, {
      type: 'session.history.loaded',
      messages: [
        { role: 'user', content: 'read package' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-read',
              toolName: 'read',
              input: { path: 'package.json' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-read',
              output: {
                type: 'json',
                value: {
                  kind: 'coding-tool-result',
                  title: 'Read package.json',
                  output: '{ "name": "demo" }',
                  metadata: { totalLines: 3 },
                },
              },
            },
          ],
        },
      ] as never,
      entryIds: ['entry-user', 'entry-assistant', 'entry-tool'],
    });

    expect(state.history).toHaveLength(2);
    expect(state.history[0]).toMatchObject({
      kind: 'user',
      entryId: 'entry-user',
    });
    expect(state.history.at(-1)).toMatchObject({
      kind: 'tool',
      tool: {
        id: 'call-read',
        name: 'read',
        input: { path: 'package.json' },
        status: 'ok',
        output: {
          kind: 'coding-tool-result',
          metadata: { totalLines: 3 },
        },
      },
    });
    expect(state.history.some((item) => item.kind === 'system')).toBe(false);
  });

  it('throws when historical tool result has no matching tool call', () => {
    expect(() =>
      reduceTuiEvent(initialTuiEventState, {
        type: 'session.history.loaded',
        messages: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'missing-call',
                output: { type: 'text', value: 'orphan' },
              },
            ],
          },
        ] as never,
      }),
    ).toThrow('Tool result without tool call');
  });

  it('clears history and runtime view state', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'user.input',
      text: 'hello',
    });
    state = reduceTuiEvent(state, {
      type: 'tool.started',
      toolCallId: 't1',
      name: 'read',
      input: {},
    });

    state = reduceTuiEvent(state, { type: 'ui.clear' });

    expect(state).toEqual(initialTuiEventState);
  });

  it('shows an interrupt notice and clears live running state', () => {
    let state = reduceTuiEvent(initialTuiEventState, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'partial',
    });
    state = reduceTuiEvent(state, {
      type: 'tool.started',
      toolCallId: 't1',
      name: 'read',
      input: {},
    });

    state = reduceTuiEvent(state, {
      type: 'ui.interrupted',
      reason: 'user interrupted from TUI',
    });

    expect(state.status).toBe('idle');
    expect(state.live.assistantText).toBe('');
    expect(state.live.runningTools.size).toBe(0);
    expect(state.live.runningSubagents.size).toBe(0);
    expect(state.interruptNotice).toContain('user interrupted');
  });
});
