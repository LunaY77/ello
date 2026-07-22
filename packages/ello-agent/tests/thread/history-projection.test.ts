/**
 * 验证 Thread records 是模型历史的唯一事实源，并在投影边界拒绝非法消息结构。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compactionView } from '../../src/features/thread/compact.js';
import { ThreadLogStore } from '../../src/storage/threads/thread-log.js';

const roots: string[] = [];
const THREAD_SETTINGS = {
  mode: 'ask-before-changes',
  profile: 'main',
  model: 'openai/gpt-5.5',
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
