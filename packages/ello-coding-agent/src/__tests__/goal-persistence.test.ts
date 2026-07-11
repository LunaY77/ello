import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GoalService } from '../goal/service.js';
import { createGoalSessionPort } from '../goal/session-port.js';
import { JsonlSessionRepository } from '../session/repository.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRepository() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ello-goal-cwd-'));
  const sessionDir = await mkdtemp(path.join(tmpdir(), 'ello-goal-session-'));
  directories.push(cwd, sessionDir);
  return new JsonlSessionRepository({ cwd, sessionDir });
}

describe('goal JSONL persistence', () => {
  it('restores the latest snapshot without advancing the message leaf', async () => {
    const repository = await createRepository();
    const sessionId = 'session-1';
    await repository.open(sessionId);
    await repository.appendMessages(sessionId, null, [
      { role: 'user', content: 'hello' },
    ]);
    const before = await repository.load(sessionId);
    const service = new GoalService({
      port: createGoalSessionPort({ repository, sessionId: () => sessionId }),
      maxContinuations: 20,
      createId: () => 'goal-1',
    });
    await service.load();
    await service.create('finish the work');
    await service.pause();

    const after = await repository.load(sessionId);
    const restored = new GoalService({
      port: createGoalSessionPort({ repository, sessionId: () => sessionId }),
      maxContinuations: 20,
    });
    await restored.load();

    expect(after.leafEntryId).toBe(before.leafEntryId);
    expect(after.messages).toEqual(before.messages);
    expect(restored.current()).toMatchObject({
      id: 'goal-1',
      status: 'paused',
      objective: 'finish the work',
    });
  });

  it('forks a snapshot with a new id and paused status', async () => {
    const repository = await createRepository();
    const sessionId = 'session-1';
    await repository.open(sessionId);
    await repository.appendMessages(sessionId, null, [
      { role: 'user', content: 'hello' },
    ]);
    const service = new GoalService({
      port: createGoalSessionPort({ repository, sessionId: () => sessionId }),
      maxContinuations: 20,
      createId: () => 'goal-1',
    });
    await service.load();
    await service.create('finish the work');

    const fork = await repository.fork(sessionId);
    const forkedGoal = await repository.latestGoal(fork.sessionId);

    expect(forkedGoal).toMatchObject({
      objective: 'finish the work',
      status: 'paused',
    });
    expect(forkedGoal?.id).not.toBe('goal-1');
    expect(forkedGoal).not.toHaveProperty('activeSince');
  });

  it('uses goal-cleared as a distinct latest-wins audit record', async () => {
    const repository = await createRepository();
    const sessionId = 'session-1';
    const service = new GoalService({
      port: createGoalSessionPort({ repository, sessionId: () => sessionId }),
      maxContinuations: 20,
      createId: () => 'goal-1',
    });
    await service.load();
    await service.create('finish the work');
    await service.clear();

    expect(await repository.latestGoal(sessionId)).toBeNull();
    expect(await repository.exportJsonl(sessionId)).toContain(
      '"kind":"goal-cleared"',
    );
  });
});
