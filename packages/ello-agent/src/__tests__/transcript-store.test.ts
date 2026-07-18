import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '../agent/engine/index.js';
import { ThreadLogRepository } from '../storage/threads/thread-log.js';
import { ThreadTranscriptStore } from '../storage/threads/transcript-store.js';

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

describe('ThreadTranscriptStore', () => {
  it('经同一 writer 连续提交，并按 JSON 语义清理 nested undefined', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-transcript-'));
    roots.push(root);
    const logs = new ThreadLogRepository({ root });
    await logs.create('thr_transcript', {
      kind: 'thread.created',
      rootId: 'thr_transcript',
      cwd: root,
      name: '',
      settings: THREAD_SETTINGS,
      metadata: {},
    });
    const committedSeq: number[] = [];
    const unsubscribe = logs.subscribe('thr_transcript', (record) => {
      committedSeq.push(record.seq);
    });
    const transcript = new ThreadTranscriptStore(logs);
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done', providerOptions: undefined }],
    } as unknown as AgentMessage;

    await transcript.append('thr_transcript', [message], {
      turnId: 'turn_transcript',
    });

    const records = await logs.read('thr_transcript');
    expect(committedSeq).toEqual([2]);
    expect(records[1]).toMatchObject({
      kind: 'transcript.entry',
      seq: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });
    unsubscribe();
  });

  it('不可 JSON 序列化的 transcript 直接失败', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-transcript-'));
    roots.push(root);
    const logs = new ThreadLogRepository({ root });
    await logs.create('thr_invalid', {
      kind: 'thread.created',
      rootId: 'thr_invalid',
      cwd: root,
      name: '',
      settings: THREAD_SETTINGS,
      metadata: {},
    });
    const transcript = new ThreadTranscriptStore(logs);

    await expect(
      transcript.append(
        'thr_invalid',
        [{ role: 'assistant', content: 1n } as unknown as AgentMessage],
        { turnId: 'turn_invalid' },
      ),
    ).rejects.toThrow('BigInt');
  });
});
