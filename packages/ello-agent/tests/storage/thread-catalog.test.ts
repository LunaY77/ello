/**
 * 本文件验证 thread-catalog 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as storageSchema from '../../src/infra/database/schema.js';
import {
  parseThreadRecord,
  type ThreadRecord,
} from '../../src/storage/threads/thread-record.js';
import { createTestStores, type TestStores } from '../support/stores.js';

const CREATED_AT = '2026-07-18T00:00:00.000Z';

describe('Thread catalog projection', () => {
  let root: string;
  let storage: TestStores;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-thread-catalog-'));
    storage = createTestStores({
      databasePath: join(root, 'state.sqlite'),
      artifactsDir: join(root, 'artifacts'),
    });
  });

  afterEach(async () => {
    storage.close();
    await rm(root, { force: true, recursive: true });
  });

  it('使用稳定 SQL 排序、cwd 过滤和数字 offset 分页', () => {
    storage.threads.apply(createdRecord('thr_a', '/workspace', 'first'));
    storage.threads.apply(createdRecord('thr_b', '/workspace', 'second'));
    storage.threads.apply(createdRecord('thr_c', '/other', 'archived'));
    storage.threads.apply(
      threadRecord({
        kind: 'thread.metadata',
        schema: 1,
        seq: 2,
        threadId: 'thr_c',
        createdAt: '2026-07-18T00:01:00.000Z',
        archived: true,
      }),
    );

    expect(
      storage.threads.list({
        archived: false,
        cwd: '/workspace',
        offset: 0,
        limit: 1,
      }),
    ).toEqual({
      data: [expect.objectContaining({ id: 'thr_b', name: 'second' })],
      hasMore: true,
    });
    expect(
      storage.threads.list({
        archived: false,
        cwd: '/workspace',
        offset: 1,
        limit: 1,
      }),
    ).toEqual({
      data: [expect.objectContaining({ id: 'thr_a', name: 'first' })],
      hasMore: false,
    });
    expect(
      storage.threads.list({ archived: true, offset: 0, limit: 10 }).data,
    ).toEqual([
      expect.objectContaining({
        id: 'thr_c',
        archived: true,
        status: 'archived',
      }),
    ]);
  });

  it('settings-only metadata 只推进 catalog seq', () => {
    const threadId = 'thr_settings';
    storage.threads.apply(createdRecord(threadId, '/workspace', 'settings'));

    storage.threads.apply(
      threadRecord({
        kind: 'thread.metadata',
        schema: 1,
        seq: 2,
        threadId,
        createdAt: CREATED_AT,
        settings: {
          mode: 'ask-before-changes',
          profile: 'deepseek',
          model: 'deepseek/deepseek-v4-flash',
          agent: 'primary',
        },
      }),
    );

    expect(storage.threads.state(threadId)).toEqual({
      id: threadId,
      seq: 2,
      archived: false,
    });
  });

  it('事务化投影 item delta、Server Request 和 compaction', () => {
    const threadId = 'thr_projection';
    const turnId = 'turn_projection';
    const itemId = 'item_projection';
    const records: ThreadRecord[] = [
      createdRecord(threadId, '/workspace', 'projection'),
      threadRecord({
        kind: 'turn.started',
        schema: 1,
        seq: 2,
        threadId,
        createdAt: CREATED_AT,
        turn: {
          id: turnId,
          threadId,
          status: 'inProgress',
          items: [],
          startedAt: CREATED_AT,
        },
      }),
      threadRecord({
        kind: 'item.started',
        schema: 1,
        seq: 3,
        threadId,
        createdAt: CREATED_AT,
        turnId,
        item: {
          id: itemId,
          turnId,
          type: 'agentMessage',
          text: 'hello',
          phase: 'final',
          status: 'inProgress',
          createdAt: CREATED_AT,
        },
      }),
      threadRecord({
        kind: 'item.delta',
        schema: 1,
        seq: 4,
        threadId,
        createdAt: CREATED_AT,
        turnId,
        itemId,
        delta: { type: 'agentMessage', text: ' world' },
      }),
      threadRecord({
        kind: 'serverRequest.created',
        schema: 1,
        seq: 5,
        threadId,
        createdAt: CREATED_AT,
        request: {
          id: 'srvreq_projection',
          method: 'item/commandExecution/requestApproval',
          threadId,
          turnId,
          itemId,
          params: { command: 'true' },
          createdAt: CREATED_AT,
        },
      }),
      threadRecord({
        kind: 'serverRequest.resolved',
        schema: 1,
        seq: 6,
        threadId,
        createdAt: CREATED_AT,
        requestId: 'srvreq_projection',
        turnId,
        itemId,
        resolution: 'resolved',
      }),
      threadRecord({
        kind: 'compaction',
        schema: 1,
        seq: 7,
        threadId,
        createdAt: CREATED_AT,
        turnId,
        summary: 'summary',
        firstKeptSeq: 3,
        tokensBefore: 100,
      }),
    ];
    for (const record of records) storage.threads.apply(record);

    const item = storage.db
      .select()
      .from(storageSchema.threadItemCatalog)
      .where(eq(storageSchema.threadItemCatalog.id, itemId))
      .get();
    expect(JSON.parse(item?.payloadJson ?? '{}')).toMatchObject({
      id: itemId,
      text: 'hello world',
      status: 'inProgress',
    });
    expect(
      storage.db
        .select()
        .from(storageSchema.threadRequestCatalog)
        .where(eq(storageSchema.threadRequestCatalog.id, 'srvreq_projection'))
        .get(),
    ).toMatchObject({
      status: 'resolved',
      resolutionJson: JSON.stringify({ resolution: 'resolved' }),
    });
    expect(
      storage.db
        .select()
        .from(storageSchema.threadCheckpointCatalog)
        .where(eq(storageSchema.threadCheckpointCatalog.id, 'thr_projection:7'))
        .get(),
    ).toMatchObject({ kind: 'compaction', summary: 'summary' });
    expect(storage.threads.state(threadId)).toEqual({
      id: threadId,
      seq: 7,
      archived: false,
    });
  });

  it('拒绝 seq 跳跃，rebuild 失败时保留旧投影', () => {
    const threadId = 'thr_rebuild';
    const created = createdRecord(threadId, '/workspace', 'original');
    const renamed = threadRecord({
      kind: 'thread.metadata',
      schema: 1,
      seq: 2,
      threadId,
      createdAt: CREATED_AT,
      name: 'persisted',
    });
    storage.threads.apply(created);
    storage.threads.apply(renamed);

    expect(() =>
      storage.threads.apply(
        threadRecord({
          kind: 'thread.status',
          schema: 1,
          seq: 4,
          threadId,
          createdAt: CREATED_AT,
          status: 'running',
          activeFlags: ['turn'],
        }),
      ),
    ).toThrow('is at seq 2, cannot apply seq 4');
    expect(() =>
      storage.threads.rebuild([
        createdRecord(threadId, '/workspace', 'replacement'),
        threadRecord({
          kind: 'item.started',
          schema: 1,
          seq: 2,
          threadId,
          createdAt: CREATED_AT,
          turnId: 'turn_missing',
          item: {
            id: 'item_orphan',
            turnId: 'turn_missing',
            type: 'notice',
            level: 'info',
            message: 'orphan',
            createdAt: CREATED_AT,
          },
        }),
      ]),
    ).toThrow();
    expect(storage.threads.state(threadId)?.seq).toBe(2);
    expect(
      storage.threads.list({ archived: false, offset: 0, limit: 10 }).data[0]
        ?.name,
    ).toBe('persisted');

    storage.threads.rebuild([
      createdRecord(threadId, '/workspace', 'replacement'),
    ]);
    expect(storage.threads.state(threadId)?.seq).toBe(1);
    expect(
      storage.threads.list({ archived: false, offset: 0, limit: 10 }).data[0]
        ?.name,
    ).toBe('replacement');
    expect(storage.threads.delete(threadId)).toBe(true);
    expect(storage.threads.delete(threadId)).toBe(false);
  });
});

function createdRecord(
  threadId: string,
  cwd: string,
  name: string,
): ThreadRecord {
  return threadRecord({
    kind: 'thread.created',
    schema: 1,
    seq: 1,
    threadId,
    createdAt: CREATED_AT,
    rootId: threadId,
    cwd,
    name,
    settings: {
      mode: 'ask-before-changes',
      profile: 'main',
      model: 'test:model',
      agent: 'primary',
    },
    metadata: {},
  });
}

function threadRecord(value: unknown): ThreadRecord {
  return parseThreadRecord(value, 'test');
}
