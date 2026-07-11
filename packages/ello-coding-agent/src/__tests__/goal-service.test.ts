import { describe, expect, it } from 'vitest';

import { GoalService } from '../goal/service.js';
import type { GoalSessionPort } from '../goal/session-port.js';
import type { GoalState } from '../goal/types.js';

function createHarness(maxContinuations = 20) {
  let snapshot: GoalState | null = null;
  let clearedId: string | null = null;
  let timestamp = Date.parse('2026-07-10T00:00:00.000Z');
  const port: GoalSessionPort = {
    load: async () => snapshot,
    save: async (goal) => {
      snapshot = goal;
    },
    clear: async (goalId) => {
      clearedId = goalId;
      snapshot = null;
    },
  };
  const service = new GoalService({
    port,
    maxContinuations,
    now: () => new Date(timestamp),
    createId: () => 'goal-1',
  });
  return {
    service,
    advance(milliseconds: number) {
      timestamp += milliseconds;
    },
    clearedId: () => clearedId,
  };
}

const usage = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 80,
  cacheWriteTokens: 0,
  toolCalls: 0,
};

describe('GoalService', () => {
  it('rejects invalid objectives, budgets, and active replacement', async () => {
    const { service } = createHarness();
    await service.load();

    await expect(service.create('   ')).rejects.toThrow('must not be empty');
    await expect(service.create('x'.repeat(4001))).rejects.toThrow(
      'must not exceed 4000',
    );
    await expect(service.create('work', 0)).rejects.toThrow('positive integer');
    await service.create('work');
    await expect(service.create('replacement')).rejects.toThrow(
      'already exists',
    );
  });

  it('pauses, resumes, and records an explicit clear audit', async () => {
    const { service, advance, clearedId } = createHarness();
    await service.load();
    await service.create('finish the implementation');
    advance(2500);

    const paused = await service.pause();
    expect(paused).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
      activeMs: 2500,
    });
    expect(paused).not.toHaveProperty('activeSince');

    const resumed = await service.resume();
    expect(resumed.status).toBe('active');
    expect(resumed).not.toHaveProperty('pauseReason');

    await service.clear();
    expect(service.current()).toBeNull();
    expect(clearedId()).toBe('goal-1');
  });

  it('requires three distinct runs with the same blocker fingerprint', async () => {
    const { service } = createHarness();
    await service.load();
    await service.create('ship it');

    const first = await service.update('blocked', 'Missing API key', 'run-1');
    const duplicate = await service.update(
      'blocked',
      'Missing API key',
      'run-1',
    );
    const second = await service.update('blocked', 'Missing API key', 'run-2');
    const third = await service.update('blocked', 'missing api key', 'run-3');

    expect(first).toMatchObject({ applied: false });
    expect(duplicate.goal.blockerStreak).toBe(1);
    expect(second.goal.blockerStreak).toBe(2);
    expect(third).toMatchObject({ applied: true, goal: { status: 'blocked' } });
  });

  it('resets blocker streak when the normalized condition changes', async () => {
    const { service } = createHarness();
    await service.load();
    await service.create('ship it');

    await service.update('blocked', 'Missing API key', 'run-1');
    const changed = await service.update('blocked', 'Network offline', 'run-2');

    expect(changed.goal).toMatchObject({
      status: 'active',
      blockerReason: 'Network offline',
      blockerStreak: 1,
    });
  });

  it('excludes cache reads and pauses at the explicit token budget', async () => {
    const { service } = createHarness();
    await service.load();
    const goal = await service.create('use the budget', 40);

    const updated = await service.recordUsage(goal.id, usage);

    expect(updated).toMatchObject({
      tokensUsed: 40,
      status: 'paused',
      pauseReason: 'token_budget',
    });
  });

  it('pauses at the host continuation limit without marking complete', async () => {
    const { service } = createHarness(1);
    await service.load();
    const goal = await service.create('continue once');
    await service.beginContinuation();

    const updated = await service.recordUsage(goal.id, {
      ...usage,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
    });

    expect(updated).toMatchObject({
      status: 'paused',
      pauseReason: 'continuation_limit',
      continuationTurns: 1,
    });
    await expect(service.resume()).rejects.toThrow(
      'Continuation limit is exhausted',
    );
  });
});
