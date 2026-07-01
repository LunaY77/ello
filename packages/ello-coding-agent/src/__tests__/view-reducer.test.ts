import { describe, expect, it } from 'vitest';

import { initialViewState, reduce } from '../tui/state/view-reducer.js';

describe('view-reducer', () => {
  it('accumulates assistant deltas and flushes on run.completed', () => {
    let state = initialViewState;
    state = reduce(state, {
      type: 'message.started',
      messageId: 'm1',
      role: 'assistant',
    });
    state = reduce(state, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'Hel',
    });
    state = reduce(state, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'lo',
    });
    expect(state.liveAssistantText).toBe('Hello');

    state = reduce(state, {
      type: 'run.completed',
      // 只取需要的字段，其余在 reducer 里不读。
      result: { output: 'Hello' } as never,
    });
    expect(state.liveAssistantText).toBe('');
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'Hello',
    });
  });

  it('uses run.completed output when no assistant delta was streamed', () => {
    const state = reduce(initialViewState, {
      type: 'run.completed',
      result: {
        output: 'final answer from provider',
        text: 'final answer from provider',
        messages: [{ role: 'assistant', content: 'final answer from provider' }],
      } as never,
    });

    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'final answer from provider',
    });
  });

  it('does not duplicate run.completed output after streaming deltas', () => {
    let state = reduce(initialViewState, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'streamed answer',
    });
    state = reduce(state, {
      type: 'run.completed',
      result: {
        output: 'streamed answer',
        text: 'streamed answer',
        messages: [{ role: 'assistant', content: 'streamed answer' }],
      } as never,
    });

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'streamed answer',
    });
  });

  it('flushes a live assistant segment when the next assistant message starts', () => {
    let state = reduce(initialViewState, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'intermediate note',
    });

    state = reduce(state, {
      type: 'message.started',
      messageId: 'm2',
      role: 'assistant',
    });

    expect(state.liveAssistantText).toBe('');
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'intermediate note',
    });
  });

  it('does not replay historical assistant tool-call messages as raw json', () => {
    const state = reduce(initialViewState, {
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

    expect(state.transcript).toHaveLength(0);
  });

  it('moves a tool from running to a sealed transcript card', () => {
    let state = initialViewState;
    state = reduce(state, {
      type: 'tool.started',
      toolCallId: 't1',
      name: 'read',
      input: { path: 'a.ts' },
    });
    expect(state.runningTools.get('t1')?.status).toBe('running');

    state = reduce(state, {
      type: 'tool.completed',
      toolCallId: 't1',
      output: { totalLines: 3 },
    });
    expect(state.runningTools.has('t1')).toBe(false);
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'tool' });
  });

  it('renders subagent runtime and nested tool activity', () => {
    let state = initialViewState;
    state = reduce(state, {
      type: 'subagent.started',
      runId: 'task-1',
      agentName: 'explore',
      description: 'inspect config loader',
      background: false,
      startedAt: '2026-07-01T00:00:00.000Z',
    });
    state = reduce(state, {
      type: 'subagent.event',
      runId: 'task-1',
      event: {
        type: 'tool.started',
        toolCallId: 'read-1',
        name: 'read',
        input: { path: 'src/config.ts' },
      },
    });
    state = reduce(state, {
      type: 'subagent.event',
      runId: 'task-1',
      event: {
        type: 'tool.completed',
        toolCallId: 'read-1',
        output: 'ok',
      },
    });

    expect(state.runningSubagents.get('task-1')).toMatchObject({
      agentName: 'explore',
      tools: [{ id: 'read-1', status: 'ok' }],
    });

    state = reduce(state, {
      type: 'subagent.completed',
      runId: 'task-1',
      output: 'config loader summary',
      completedAt: '2026-07-01T00:00:02.000Z',
    });

    expect(state.runningSubagents.has('task-1')).toBe(false);
    expect(state.transcript.at(-1)).toMatchObject({
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
    let state = initialViewState;
    state = reduce(state, {
      type: 'approval.pending',
      requestId: 'r1',
      toolName: 'write',
      input: {},
    });
    expect(state.status).toBe('awaiting_approval');
    expect(state.pendingApproval?.requestId).toBe('r1');

    state = reduce(state, { type: 'status', state: 'idle' });
    expect(state.pendingApproval).toBeUndefined();
  });

  it('renders product messages into the transcript', () => {
    const state = reduce(initialViewState, {
      type: 'ui.message',
      text: 'Model switched to fake:test',
    });

    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'system',
      text: 'Model switched to fake:test',
    });
  });

  it('replays historical tool calls as compact tool cards instead of raw JSON', () => {
    const state = reduce(initialViewState, {
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

    expect(state.transcript).toHaveLength(2);
    expect(state.transcript[0]).toMatchObject({
      kind: 'user',
      entryId: 'entry-user',
    });
    expect(state.transcript.at(-1)).toMatchObject({
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
    expect(state.transcript.some((item) => item.kind === 'system')).toBe(false);
  });

  it('clears transcript and runtime view state', () => {
    let state = reduce(initialViewState, {
      type: 'user.input',
      text: 'hello',
    });
    state = reduce(state, {
      type: 'tool.started',
      toolCallId: 't1',
      name: 'read',
      input: {},
    });

    state = reduce(state, { type: 'ui.clear' });

    expect(state).toEqual(initialViewState);
  });

  it('shows an interrupt notice and clears live running state', () => {
    let state = reduce(initialViewState, {
      type: 'message.delta',
      messageId: 'm1',
      text: 'partial',
    });
    state = reduce(state, {
      type: 'tool.started',
      toolCallId: 't1',
      name: 'read',
      input: {},
    });

    state = reduce(state, {
      type: 'ui.interrupted',
      reason: 'user interrupted from TUI',
    });

    expect(state.status).toBe('idle');
    expect(state.liveAssistantText).toBe('');
    expect(state.runningTools.size).toBe(0);
    expect(state.runningSubagents.size).toBe(0);
    expect(state.interruptNotice).toContain('user interrupted');
  });
});
