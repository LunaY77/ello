/**
 * 验证 Thread records 是模型历史的唯一事实源，并在投影边界拒绝非法消息结构。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compactionView } from '../../src/features/thread/compact.js';
import { projectThreadSnapshot } from '../../src/features/thread/records.js';
import { ThreadLogStore } from '../../src/storage/threads/thread-log.js';

const roots: string[] = [];
const THREAD_SETTINGS = {
  mode: 'ask-before-changes',
  agent: 'build',
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('Thread history projection', () => {
  it('按 record seq 投影 transcript，并应用最新 compaction checkpoint', async () => {
    const logs = await createLogs('thr_history');
    await logs.append('thr_history', {
      kind: 'transcript.entry',
      turnId: 'turn_1',
      role: 'user',
      message: { role: 'user', content: 'old question' },
    });
    await logs.append('thr_history', {
      kind: 'transcript.entry',
      turnId: 'turn_2',
      role: 'assistant',
      message: { role: 'assistant', content: 'kept answer' },
    });
    await logs.append('thr_history', {
      kind: 'compaction',
      turnId: 'turn_2',
      summary: 'checkpoint',
      firstKeptSeq: 3,
      tokensBefore: 8,
    });

    expect(
      compactionView(await logs.read('thr_history')).projectedMessages,
    ).toEqual([
      {
        role: 'user',
        content: '<compact-checkpoint>\ncheckpoint\n</compact-checkpoint>',
      },
      { role: 'assistant', content: 'kept answer' },
    ]);
  });

  it('存储中的非法 Agent message 在历史投影边界直接失败', async () => {
    const logs = await createLogs('thr_invalid_history');
    await logs.append('thr_invalid_history', {
      kind: 'transcript.entry',
      turnId: 'turn_invalid',
      role: 'assistant',
      message: { role: 'assistant', content: 42 },
    });

    const records = await logs.read('thr_invalid_history');
    expect(() => compactionView(records)).toThrow('invalid role or content');
  });

  it('恢复 snapshot 时保留手动 compact 的完整 checkpoint 和统计', async () => {
    const logs = await createLogs('thr_manual_compact');
    const startedAt = '2026-07-18T00:00:00.000Z';
    await logs.append('thr_manual_compact', {
      kind: 'turn.started',
      turn: {
        id: 'turn_manual',
        threadId: 'thr_manual_compact',
        status: 'inProgress',
        items: [],
        startedAt,
      },
    });
    await logs.append('thr_manual_compact', {
      kind: 'turn.completed',
      turn: {
        id: 'turn_manual',
        threadId: 'thr_manual_compact',
        status: 'completed',
        items: [],
        startedAt,
        completedAt: '2026-07-18T00:00:05.000Z',
      },
    });
    await logs.append('thr_manual_compact', {
      kind: 'compaction',
      turnId: 'turn_manual',
      summary: '## Goal\nPreserve the compact checkpoint.',
      firstKeptSeq: 2,
      tokensBefore: 4_096,
      beforeMessageCount: 12,
      afterMessageCount: 3,
      keptMessageCount: 2,
    });

    const snapshot = projectThreadSnapshot(
      await logs.read('thr_manual_compact'),
    );
    expect(snapshot.turns[0]?.items).toEqual([
      expect.objectContaining({
        type: 'contextCompaction',
        summary: '## Goal\nPreserve the compact checkpoint.',
        tokensBefore: 4_096,
        beforeMessageCount: 12,
        afterMessageCount: 3,
        keptMessageCount: 2,
        status: 'completed',
      }),
    ]);
  });

  it('自动 compact 已有进行中 item 时不投影重复 checkpoint', async () => {
    const logs = await createLogs('thr_auto_compact');
    const startedAt = '2026-07-18T00:00:00.000Z';
    const inProgressItem = {
      type: 'contextCompaction' as const,
      id: 'compact-auto',
      turnId: 'turn_auto',
      createdAt: startedAt,
      summary: 'Compacting 12 messages…',
      tokensBefore: 4_096,
      status: 'inProgress' as const,
    };
    await logs.append('thr_auto_compact', {
      kind: 'turn.started',
      turn: {
        id: 'turn_auto',
        threadId: 'thr_auto_compact',
        status: 'inProgress',
        items: [],
        startedAt,
      },
    });
    await logs.append('thr_auto_compact', {
      kind: 'item.started',
      turnId: 'turn_auto',
      item: inProgressItem,
    });
    await logs.append('thr_auto_compact', {
      kind: 'compaction',
      turnId: 'turn_auto',
      summary: '## Goal\nPreserve the compact checkpoint.',
      firstKeptSeq: 2,
      tokensBefore: 4_096,
      beforeMessageCount: 12,
      afterMessageCount: 3,
      keptMessageCount: 2,
    });
    await logs.append('thr_auto_compact', {
      kind: 'item.completed',
      turnId: 'turn_auto',
      item: {
        ...inProgressItem,
        summary: '## Goal\nPreserve the compact checkpoint.',
        beforeMessageCount: 12,
        afterMessageCount: 3,
        keptMessageCount: 2,
        status: 'completed',
      },
    });

    const snapshot = projectThreadSnapshot(await logs.read('thr_auto_compact'));
    expect(snapshot.turns[0]?.items).toHaveLength(1);
    expect(snapshot.turns[0]?.items[0]).toMatchObject({
      id: 'compact-auto',
      type: 'contextCompaction',
      summary: '## Goal\nPreserve the compact checkpoint.',
      status: 'completed',
    });
  });
});

async function createLogs(threadId: string): Promise<ThreadLogStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-history-'));
  roots.push(root);
  const logs = new ThreadLogStore({ root });
  await logs.create(threadId, {
    kind: 'thread.created',
    rootId: threadId,
    cwd: root,
    name: '',
    settings: THREAD_SETTINGS,
    metadata: {},
  });
  return logs;
}
