import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectThreadSnapshot } from '../../src/domain/projection/thread-snapshot.js';
import { AppServerError } from '../../src/protocol/errors.js';
import {
  archivedThreadLogPath,
  threadLeasePath,
  threadLogPath,
} from '../../src/storage/paths.js';
import { ThreadLeaseStore } from '../../src/storage/threads/thread-lease.js';
import { ThreadLogRepository } from '../../src/storage/threads/thread-log.js';

const threadId = 'thr_test';
const turnId = 'turn_test';
const itemId = 'item_test';

describe('ThreadLogRepository', () => {
  let root: string;
  let repository: ThreadLogRepository;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-thread-log-'));
    repository = new ThreadLogRepository({ root });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('串行写入并从日志重建 Thread/Turn/Item snapshot', async () => {
    await createThread(repository);
    const startedAt = new Date().toISOString();
    await repository.append(threadId, {
      kind: 'turn.started',
      turn: {
        id: turnId,
        threadId,
        status: 'inProgress',
        items: [],
        startedAt,
      },
    });
    await repository.append(threadId, {
      kind: 'item.started',
      turnId,
      item: {
        type: 'agentMessage',
        id: itemId,
        turnId,
        createdAt: startedAt,
        text: '',
        phase: 'final',
        status: 'inProgress',
      },
    });
    await repository.append(threadId, {
      kind: 'item.delta',
      turnId,
      itemId,
      delta: { type: 'agentMessage', text: 'hello' },
    });
    await repository.append(threadId, {
      kind: 'item.completed',
      turnId,
      item: {
        type: 'agentMessage',
        id: itemId,
        turnId,
        createdAt: startedAt,
        text: 'hello',
        phase: 'final',
        status: 'completed',
      },
    });
    await repository.append(threadId, {
      kind: 'turn.completed',
      turn: {
        id: turnId,
        threadId,
        status: 'completed',
        items: [],
        startedAt,
        completedAt: new Date().toISOString(),
        usage: {
          requests: 1,
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          toolCalls: 0,
        },
      },
    });

    const records = await repository.read(threadId);
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const snapshot = projectThreadSnapshot(records);
    expect(snapshot.thread.id).toBe(threadId);
    expect(snapshot.thread.status).toBe('idle');
    expect(snapshot.turns[0]?.items).toEqual([
      expect.objectContaining({
        id: itemId,
        text: 'hello',
        status: 'completed',
      }),
    ]);
  });

  it('并发 append 仍生成连续 seq', async () => {
    await createThread(repository);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.append(threadId, {
          kind: 'thread.metadata',
          preview: `preview-${index}`,
        }),
      ),
    );
    expect(
      (await repository.read(threadId)).map((record) => record.seq),
    ).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
  });

  it.each([
    ['incomplete final line', (content: string) => content.slice(0, -1)],
    [
      'seq gap',
      (content: string) =>
        `${content}${JSON.stringify({
          schema: 1,
          seq: 3,
          threadId,
          createdAt: new Date().toISOString(),
          kind: 'thread.metadata',
          preview: 'bad',
        })}\n`,
    ],
    [
      'wrong thread id',
      (content: string) =>
        content.replace(`"threadId":"${threadId}"`, '"threadId":"thr_other"'),
    ],
  ])('对 %s fail fast', async (_name, mutate) => {
    await createThread(repository);
    const path = threadLogPath(threadId, root);
    await writeFile(path, mutate(await readFile(path, 'utf8')), 'utf8');
    await expect(repository.read(threadId)).rejects.toMatchObject({
      type: 'storageCorrupt',
    });
  });

  it('archive 与 unarchive 不创建第二份事实源', async () => {
    await createThread(repository);
    await repository.archive(threadId);
    await expect(repository.read(threadId)).rejects.toMatchObject({
      type: 'threadNotFound',
    });
    await expect(repository.readArchived(threadId)).resolves.toHaveLength(1);
    await repository.unarchive(threadId);
    await expect(repository.read(threadId)).resolves.toHaveLength(1);
  });

  it('read/archive/delete/unarchive 与路径 helper 拒绝 traversal 且不触碰外部文件', async () => {
    const traversalId = '../../sentinel';
    const sentinelPath = join(root, 'sentinel.jsonl');
    const sentinel = 'outside-thread-storage\n';
    await writeFile(sentinelPath, sentinel, 'utf8');

    expect(() => threadLogPath(traversalId, root)).toThrow('Unsafe storage id');
    expect(() => archivedThreadLogPath(traversalId, root)).toThrow(
      'Unsafe storage id',
    );
    const operations: readonly [string, () => Promise<unknown>][] = [
      ['read', () => repository.read(traversalId)],
      ['readArchived', () => repository.readArchived(traversalId)],
      ['archive', () => repository.archive(traversalId)],
      ['unarchive', () => repository.unarchive(traversalId)],
      ['delete active', () => repository.delete(traversalId, false)],
      ['delete archived', () => repository.delete(traversalId, true)],
    ];
    for (const [name, operation] of operations) {
      await expect(operation(), name).rejects.toThrow('Unsafe storage id');
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe(sentinel);
    }
  });

  it('lease 路径独立拒绝 traversal 且不删除外部 lock sentinel', async () => {
    const traversalId = '../../sentinel';
    const sentinelPath = join(root, 'sentinel.lock');
    const sentinel = `${JSON.stringify({ pid: 999_999_999 })}\n`;
    await writeFile(sentinelPath, sentinel, 'utf8');
    const leases = new ThreadLeaseStore(root);

    expect(() => threadLeasePath(traversalId, root)).toThrow(
      'Unsafe storage id',
    );
    await expect(leases.acquire(traversalId)).rejects.toThrow(
      'Unsafe storage id',
    );
    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe(sentinel);
  });

  it('同一 thread 的第二个活跃 lease 被拒绝', async () => {
    const leases = new ThreadLeaseStore(root);
    const first = await leases.acquire(threadId);
    await expect(leases.acquire(threadId)).rejects.toEqual(
      expect.objectContaining({
        type: 'threadBusy',
      } satisfies Partial<AppServerError>),
    );
    await first.release();
    const second = await leases.acquire(threadId);
    await second.release();
  });
});

function createThread(repository: ThreadLogRepository) {
  return repository.create(threadId, {
    kind: 'thread.created',
    rootId: threadId,
    cwd: '/workspace',
    name: 'test',
    settings: {
      mode: 'ask-before-changes',
      profile: 'main',
      model: 'test:model',
      agent: 'primary',
    },
    metadata: {},
  });
}
