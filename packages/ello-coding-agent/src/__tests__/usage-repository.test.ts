import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodingStorage } from '../storage/index.js';
import { UsageRepository } from '../storage/repositories/usage-repository.js';

describe('UsageRepository', () => {
  let oldHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-usage-'));
    process.env.ELLO_HOME = home;
  });

  afterEach(async () => {
    if (oldHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = oldHome;
    }
    await rm(home, { recursive: true, force: true });
  });

  it('记录安全 usage 字段并按模型/日期/状态聚合', async () => {
    const storage = createCodingStorage();
    const repo = new UsageRepository(storage.db);
    await repo.recordUsage({
      runId: 'run-1',
      invocation: 'run',
      model: 'fake:a',
      status: 'completed',
      startedAt: '2026-06-29T00:00:00.000Z',
      usage: {
        requests: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        toolCalls: 3,
      },
    });
    await repo.recordUsage({
      runId: 'run-2',
      invocation: 'tui',
      model: 'fake:b',
      status: 'failed',
      startedAt: '2026-06-30T00:00:00.000Z',
    });

    expect(await repo.listRecords({ model: 'fake:a' })).toHaveLength(1);
    expect(await repo.summarize({}, 'model')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'fake:a', inputTokens: 10, runs: 1 }),
        expect.objectContaining({ key: 'fake:b', inputTokens: 0, runs: 1 }),
      ]),
    );
    expect(await repo.summarize({}, 'day')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: '2026-06-29', runs: 1 }),
        expect.objectContaining({ key: '2026-06-30', runs: 1 }),
      ]),
    );
    expect(await repo.summarize({}, 'status')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'completed', runs: 1 }),
        expect.objectContaining({ key: 'failed', runs: 1 }),
      ]),
    );
    storage.close();
  });
});
