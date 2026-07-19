import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createThreadCompactor } from '../../src/agent/context/thread-compactor.js';
import { CodingAgentConfigSchema } from '../../src/config/index.js';
import type { AgentMessage } from '../../src/agent/engine/index.js';
import { ThreadLogRepository } from '../../src/storage/threads/thread-log.js';
import { ThreadTranscriptStore } from '../../src/storage/threads/transcript-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('thread compactor', () => {
  it('自动压缩超预算历史，并让 transcript 读取 checkpoint 投影', async () => {
    const { logs, threadId } = await createThread();
    const compactor = createThreadCompactor({
      logs,
      config: configFor('/workspace', true),
      profileName: 'main',
      contextWindow: 10,
      generateCheckpoint: async () => 'checkpoint',
    });
    await appendMessages(logs, threadId);

    const report = await compactor.maybeCompact(threadId, {
      metadata: {},
    } as never);

    expect(report).toMatchObject({ compactor: 'ello-thread-compactor' });
    const records = await logs.read(threadId);
    expect(records.some((record) => record.kind === 'compaction')).toBe(true);
    await expect(
      new ThreadTranscriptStore(logs).load(threadId),
    ).resolves.toEqual([
      {
        role: 'user',
        content: '<compact-checkpoint>\ncheckpoint\n</compact-checkpoint>',
      },
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: 'new answer' },
    ]);
  });

  it('手动压缩即使 auto 关闭也保留最近一个 user turn', async () => {
    const { logs, threadId } = await createThread();
    const compactor = createThreadCompactor({
      logs,
      config: configFor('/workspace', false),
      profileName: 'main',
      contextWindow: 10,
      generateCheckpoint: async () => 'manual checkpoint',
    });
    await appendMessages(logs, threadId);

    await expect(
      compactor.compactNow(threadId, { force: true, turnId: 'turn_2' }),
    ).resolves.toMatchObject({ afterMessageCount: 3 });
  });

  it('多次压缩以上一次 checkpoint 为锚点并只投影最新边界', async () => {
    const { logs, threadId } = await createThread();
    const calls: Array<{
      readonly messages: readonly AgentMessage[];
      readonly previousCheckpoint?: string;
    }> = [];
    const compactor = createThreadCompactor({
      logs,
      config: configFor('/workspace', false),
      profileName: 'main',
      contextWindow: 10,
      generateCheckpoint: async (messages, previousCheckpoint) => {
        calls.push({
          messages,
          ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
        });
        return `checkpoint ${calls.length}`;
      },
    });
    await appendMessages(logs, threadId);
    await compactor.compactNow(threadId, { force: true, turnId: 'turn_2' });
    await appendMessage(logs, threadId, 'turn_3', 'user', 'latest question');
    await appendMessage(logs, threadId, 'turn_3', 'assistant', 'latest answer');

    await compactor.compactNow(threadId, { force: true, turnId: 'turn_3' });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ previousCheckpoint: 'checkpoint 1' });
    expect(calls[1]?.messages.map((message) => message.content)).toEqual([
      'new question',
      'new answer',
    ]);
    await expect(
      new ThreadTranscriptStore(logs).load(threadId),
    ).resolves.toEqual([
      {
        role: 'user',
        content: '<compact-checkpoint>\ncheckpoint 2\n</compact-checkpoint>',
      },
      { role: 'user', content: 'latest question' },
      { role: 'assistant', content: 'latest answer' },
    ]);
  });

  it('短历史没有合法边界时不生成空 checkpoint', async () => {
    const { logs, threadId } = await createThread();
    let generated = false;
    const compactor = createThreadCompactor({
      logs,
      config: configFor('/workspace', true),
      profileName: 'main',
      contextWindow: 1,
      generateCheckpoint: async () => {
        generated = true;
        return 'unexpected';
      },
    });
    await appendMessage(logs, threadId, 'turn_1', 'user', 'only message');

    await expect(
      compactor.maybeCompact(threadId, { metadata: {} } as never),
    ).resolves.toBeNull();
    expect(generated).toBe(false);
  });
});

async function createThread(): Promise<{
  readonly logs: ThreadLogRepository;
  readonly threadId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-compactor-'));
  roots.push(root);
  const logs = new ThreadLogRepository({ root });
  const threadId = 'thr_compactor';
  await logs.create(threadId, {
    kind: 'thread.created',
    rootId: threadId,
    cwd: '/workspace',
    name: '',
    settings: {
      mode: 'ask-before-changes',
      profile: 'main',
      model: 'mock/model',
      agent: 'primary',
    },
    metadata: {},
  });
  return { logs, threadId };
}

async function appendMessages(
  logs: ThreadLogRepository,
  threadId: string,
): Promise<void> {
  for (const [turnId, role, content] of [
    ['turn_1', 'user', 'old question'],
    ['turn_1', 'assistant', 'old answer'],
    ['turn_2', 'user', 'new question'],
    ['turn_2', 'assistant', 'new answer'],
  ] as const) {
    await appendMessage(logs, threadId, turnId, role, content);
  }
}

async function appendMessage(
  logs: ThreadLogRepository,
  threadId: string,
  turnId: string,
  role: AgentMessage['role'],
  content: string,
): Promise<void> {
  await logs.append(threadId, {
    kind: 'transcript.entry',
    turnId,
    role,
    message: { role, content },
  });
}

function configFor(cwd: string, auto: boolean) {
  return CodingAgentConfigSchema.parse({
    cwd,
    initial_mode: 'ask-before-changes',
    context: {
      max_input_tokens: 100,
      reserved_output_tokens: 10,
      compaction: {
        auto,
        tail_turns: 1,
        preserve_recent_tokens: 2,
        reserved_tokens: 5,
        prune_tool_output: false,
        tool_output_max_chars: 2_000,
        split_turns: true,
      },
    },
  });
}
