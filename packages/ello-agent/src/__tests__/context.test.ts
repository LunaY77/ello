import { describe, expect, it } from 'vitest';

import { AgentContext, LifecycleStatus, LocalEnvironment } from '../index.js';

describe('AgentContext', () => {
  it('prepareNewRun resets run id and preserves env', () => {
    const env = new LocalEnvironment();
    const history = new Map<string, unknown[]>([['agent', ['item']]]);
    const ctx = new AgentContext({
      env,
      forceInjectInstructions: true,
      subagentHistory: history,
    });
    ctx.emitEvent({
      runId: ctx.runId,
      timestamp: new Date(),
      status: LifecycleStatus.started,
    });
    ctx.recordUsage({
      agentId: 'main',
      agentName: 'main',
      modelId: 'test',
      source: 'test',
      usage: {
        requests: 1,
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: 0,
      },
    });

    const next = ctx.prepareNewRun();

    expect(next.runId).not.toBe(ctx.runId);
    expect(next.env).toBe(ctx.env);
    expect(next.events).toEqual([]);
    expect(next.usageSnapshot.entries).toEqual([]);
    expect(next.forceInjectInstructions).toBe(false);
    expect(next.subagentHistory).toBe(history);
  });

  it('reports elapsed time', () => {
    const env = new LocalEnvironment();
    const ctx = new AgentContext({ env });

    expect(ctx.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it('renders runtime context XML', () => {
    const env = new LocalEnvironment();
    const ctx = new AgentContext({ env });

    const instructions = ctx.getContextInstructions();

    expect(instructions).toContain('<runtime-context>');
    expect(instructions).toContain(ctx.runId);
    expect(instructions).toContain('<current-time>');
    expect(instructions).toContain('<elapsed-time>');
  });

  it('records events', () => {
    const env = new LocalEnvironment();
    const ctx = new AgentContext({ env });
    const event = {
      runId: ctx.runId,
      timestamp: new Date(),
      status: LifecycleStatus.started,
    };

    ctx.emitEvent(event);

    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]).toBe(event);
  });
});
