/**
 * 验证 Thread 消息压缩策略不接触持久化，并由 Thread 根据报告写入 compaction record。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../src/features/agent/engine/index.js';
import { CodingAgentConfigSchema } from '../../src/features/config/index.js';
import {
  appendThreadCompaction,
  compactionView,
  createThreadCompactor,
} from '../../src/features/thread/compact.js';
import { ThreadLogStore } from '../../src/storage/threads/thread-log.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('thread compactor', () => {
  it('自动压缩超预算历史，并由 Thread 写入 checkpoint 边界', async () => {
    const { logs, threadId } = await createThread();
    await appendMessages(logs, threadId);
    const before = compactionView(await logs.read(threadId));
    const compactor = createThreadCompactor({
      config: configFor('/workspace', true),
      profileName: 'main',
      generateCheckpoint: async () => 'checkpoint',
    });

    const compacted = await compactor.compact({
      messages: before.projectedMessages,
      contextWindow: 10,
      signal: new AbortController().signal,
    });
    if (compacted === null) throw new Error('Expected automatic compaction.');
    await appendThreadCompaction({
      store: logs,
      threadId,
      turnId: 'turn_2',
      view: before,
      report: compacted.report,
    });

    expect(compacted.report).toMatchObject({
      compactor: 'ello-thread-compactor',
    });
    const records = await logs.read(threadId);
    expect(records.some((record) => record.kind === 'compaction')).toBe(true);
    expect(compactionView(records).projectedMessages).toEqual([
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
    await appendMessages(logs, threadId);
    const view = compactionView(await logs.read(threadId));
    const compactor = createThreadCompactor({
      config: configFor('/workspace', false),
      profileName: 'main',
      force: true,
      generateCheckpoint: async () => 'manual checkpoint',
    });

    await expect(
      compactor.compact({
        messages: view.projectedMessages,
        contextWindow: 10,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      report: { afterMessageCount: 3, keptMessageCount: 2 },
    });
  });

  it('多次压缩以上一次 checkpoint 为锚点并只投影最新边界', async () => {
    const { logs, threadId } = await createThread();
    const calls: Array<{
      readonly messages: ReadonlyArray<AgentMessage>;
      readonly previousCheckpoint?: string;
    }> = [];
    const createCompactor = () =>
      createThreadCompactor({
        config: configFor('/workspace', false),
        profileName: 'main',
        force: true,
        generateCheckpoint: async (messages, previousCheckpoint) => {
          calls.push({
            messages,
            ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
          });
          return `checkpoint ${calls.length}`;
        },
      });
    await appendMessages(logs, threadId);
    await compactAndPersist(logs, threadId, 'turn_2', createCompactor());
    await appendMessage(logs, threadId, 'turn_3', 'user', 'latest question');
    await appendMessage(logs, threadId, 'turn_3', 'assistant', 'latest answer');

    await compactAndPersist(logs, threadId, 'turn_3', createCompactor());

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ previousCheckpoint: 'checkpoint 1' });
    expect(calls[1]?.messages.map((message) => message.content)).toEqual([
      'new question',
      'new answer',
    ]);
    expect(compactionView(await logs.read(threadId)).projectedMessages).toEqual(
      [
        {
          role: 'user',
          content: '<compact-checkpoint>\ncheckpoint 2\n</compact-checkpoint>',
        },
        { role: 'user', content: 'latest question' },
        { role: 'assistant', content: 'latest answer' },
      ],
    );
  });

  it('短历史没有合法边界时不生成空 checkpoint', async () => {
    const { logs, threadId } = await createThread();
    let generated = false;
    const compactor = createThreadCompactor({
      config: configFor('/workspace', true),
      profileName: 'main',
      generateCheckpoint: async () => {
        generated = true;
        return 'unexpected';
      },
    });
    await appendMessage(logs, threadId, 'turn_1', 'user', 'only message');
    const view = compactionView(await logs.read(threadId));

    await expect(
      compactor.compact({
        messages: view.projectedMessages,
        contextWindow: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
    expect(generated).toBe(false);
  });
});

async function compactAndPersist(
  logs: ThreadLogStore,
  threadId: string,
  turnId: string,
  compactor: ReturnType<typeof createThreadCompactor>,
): Promise<void> {
  const view = compactionView(await logs.read(threadId));
  const compacted = await compactor.compact({
    messages: view.projectedMessages,
    contextWindow: 10,
    signal: new AbortController().signal,
  });
  if (compacted === null) throw new Error('Expected manual compaction.');
  await appendThreadCompaction({
    store: logs,
    threadId,
    turnId,
    view,
    report: compacted.report,
  });
}

async function createThread(): Promise<{
  readonly logs: ThreadLogStore;
  readonly threadId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'ello-compactor-'));
  roots.push(root);
  const logs = new ThreadLogStore({ root });
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
  logs: ThreadLogStore,
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
  logs: ThreadLogStore,
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
