import { describe, expect, it } from 'vitest';

import { AgentContext, LifecycleStatus, LocalEnvironment } from '../index.js';

describe('AgentContext', () => {
  it('prepareNewRun resets run id and preserves env', () => {
    const env = new LocalEnvironment();
    const ctx = new AgentContext({ env });

    const next = ctx.prepareNewRun();

    expect(next.runId).not.toBe(ctx.runId);
    expect(next.env).toBe(ctx.env);
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
