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
    expect(state.interruptNotice).toContain('user interrupted');
  });
});
