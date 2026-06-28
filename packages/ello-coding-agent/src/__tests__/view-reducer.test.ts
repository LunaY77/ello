import { describe, expect, it } from 'vitest';

import { initialViewState, reduce } from '../tui/state/view-reducer.js';

describe('view-reducer', () => {
  it('accumulates assistant deltas and flushes on run.completed', () => {
    let state = initialViewState;
    state = reduce(state, { type: 'message.started', messageId: 'm1', role: 'assistant' });
    state = reduce(state, { type: 'message.delta', messageId: 'm1', text: 'Hel' });
    state = reduce(state, { type: 'message.delta', messageId: 'm1', text: 'lo' });
    expect(state.liveAssistantText).toBe('Hello');

    state = reduce(state, {
      type: 'run.completed',
      // 只取需要的字段，其余在 reducer 里不读。
      result: { output: 'Hello' } as never,
    });
    expect(state.liveAssistantText).toBe('');
    expect(state.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hello' });
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

    state = reduce(state, { type: 'tool.completed', toolCallId: 't1', output: { totalLines: 3 } });
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
});
