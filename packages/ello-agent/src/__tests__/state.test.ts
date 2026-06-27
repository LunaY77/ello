import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  RunState,
  isDeferredToolRequests,
  type DeferredToolRequests,
  type RunResultLike,
} from '../index.js';

function user(content: string): ModelMessage {
  return { role: 'user', content };
}

function pendingRequests(): DeferredToolRequests {
  return {
    approvals: [
      {
        toolCallId: 'call-approval-1',
        toolName: 'dangerous_action',
        input: { target: 'prod' },
      },
    ],
    calls: [
      {
        toolCallId: 'call-external-1',
        toolName: 'external_lookup',
        input: { q: 'hello' },
      },
    ],
  };
}

describe('RunState', () => {
  it('reports approval and deferred call flags', () => {
    const state = new RunState({
      messages: [user('hello')],
      pendingRequests: pendingRequests(),
      runId: 'run-1',
    });

    expect(state.needsApproval).toBe(true);
    expect(state.hasDeferredCalls).toBe(true);
    expect(state.runId).toBe('run-1');
  });

  it('reports false flags without pending requests', () => {
    const state = new RunState({ messages: [] });

    expect(state.needsApproval).toBe(false);
    expect(state.hasDeferredCalls).toBe(false);
    expect(state.pendingRequests).toBeNull();
  });

  it('builds resume results with approve all', () => {
    const state = new RunState({
      messages: [],
      pendingRequests: pendingRequests(),
    });

    const result = state.buildResumeResults({
      approveAll: true,
      calls: { 'call-external-1': { ok: true } },
    });

    expect(result.approvals).toEqual({ 'call-approval-1': true });
    expect(result.calls).toEqual({ 'call-external-1': { ok: true } });
  });

  it('builds resume results with explicit approvals', () => {
    const state = new RunState({
      messages: [],
      pendingRequests: pendingRequests(),
    });

    const result = state.buildResumeResults({
      approvals: {
        'call-approval-1': { approved: false, reason: 'blocked' },
      },
    });

    expect(result.approvals['call-approval-1']).toEqual({
      approved: false,
      reason: 'blocked',
    });
  });

  it('throws when building resume results without pending requests', () => {
    const state = new RunState({ messages: [] });

    expect(() => state.buildResumeResults()).toThrow('No pending requests');
  });

  it('round trips through JSON bytes', () => {
    const state = new RunState({
      messages: [user('hello')],
      pendingRequests: pendingRequests(),
      runId: 'round-trip',
    });

    const loaded = RunState.loadJson(state.saveJson());

    expect(loaded.runId).toBe('round-trip');
    expect(loaded.needsApproval).toBe(true);
    expect(loaded.hasDeferredCalls).toBe(true);
    expect(loaded.messages).toEqual(state.messages);
    expect(loaded.pendingRequests).toEqual(state.pendingRequests);
  });

  it('creates state from run result with deferred requests output', () => {
    const result: RunResultLike = {
      output: pendingRequests(),
      allMessages: () => [user('hello')],
    };

    const state = RunState.fromRunResult(result, 'run-result');

    expect(state.runId).toBe('run-result');
    expect(state.needsApproval).toBe(true);
    expect(state.messages).toEqual([user('hello')]);
  });

  it('creates state from run result without pending requests', () => {
    const result: RunResultLike = {
      output: 'done',
      messages: [user('hello')],
    };

    const state = RunState.fromRunResult(result);

    expect(state.needsApproval).toBe(false);
    expect(state.pendingRequests).toBeNull();
    expect(state.messages).toEqual([user('hello')]);
  });
});

describe('isDeferredToolRequests', () => {
  it('detects deferred tool requests shape', () => {
    expect(isDeferredToolRequests(pendingRequests())).toBe(true);
    expect(isDeferredToolRequests({ approvals: [] })).toBe(false);
    expect(isDeferredToolRequests(null)).toBe(false);
  });
});
