import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThreadTitleGenerator } from '../../src/domain/ports/thread-title-generator.js';
import type {
  TurnExecutionEvent,
  TurnExecutionHandle,
  TurnExecutionResult,
  TurnExecutor,
} from '../../src/domain/ports/turn-executor.js';
import type {
  ParsedClientParams,
  ThreadSnapshot,
  Usage,
  UserInput,
} from '../../src/protocol/v1/index.js';
import { ThreadManager } from '../../src/server/runtime/thread-manager.js';
import {
  createCodingStorage,
  type CodingStorage,
} from '../../src/storage/database/index.js';
import { threadLogPath } from '../../src/storage/paths.js';
import { ThreadLogRepository } from '../../src/storage/threads/thread-log.js';
import { parseThreadRecord } from '../../src/storage/threads/thread-record.js';
import { ThreadTranscriptStore } from '../../src/storage/threads/transcript-store.js';

const EMPTY_USAGE: Usage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
};

function testInitialSettings(params: ParsedClientParams<'thread/start'>) {
  return Promise.resolve({
    mode: params.mode ?? 'ask-before-changes',
    profile: params.profile ?? 'test',
    model: params.model ?? 'test:model',
    agent: params.agent ?? 'build',
  } as const);
}

function testSettingsUpdate(
  params: Omit<ParsedClientParams<'thread/settings/update'>, 'threadId'>,
): Promise<Partial<ThreadSnapshot['settings']>> {
  return Promise.resolve({
    ...(params.mode === undefined ? {} : { mode: params.mode }),
    ...(params.profile === undefined ? {} : { profile: params.profile }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.agent === undefined ? {} : { agent: params.agent }),
  });
}

describe('ThreadManager', () => {
  let root: string;
  let storage: CodingStorage;
  let logs: ThreadLogRepository;
  let executors: FakeExecutorFactory;
  let manager: ThreadManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-thread-manager-'));
    storage = createCodingStorage({
      databasePath: join(root, 'state.sqlite'),
      artifactsDir: join(root, 'artifacts'),
    });
    logs = new ThreadLogRepository({ root });
    executors = new FakeExecutorFactory();
    manager = new ThreadManager({
      root,
      logs,
      catalog: storage.threads,
      executorFactory: (snapshot) => executors.create(snapshot),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
      unloadGraceMs: 1,
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.close();
    storage.close();
    await rm(root, { force: true, recursive: true });
  });

  it('新 Thread 使用 Server 解析后的具体 settings', async () => {
    const attachment = await startThread(manager, 'connection-1');

    expect(attachment.snapshot.settings).toEqual({
      mode: 'ask-before-changes',
      profile: 'test',
      model: 'test:model',
      agent: 'build',
    });
  });

  it('不同 thread 并行运行且事件不会串线', async () => {
    const first = await startThread(manager, 'connection-1');
    const second = await startThread(manager, 'connection-2');
    const [firstTurn, secondTurn] = await Promise.all([
      first.runtime.startTurn([{ type: 'text', text: 'first' }]),
      second.runtime.startTurn([{ type: 'text', text: 'second' }]),
    ]);
    const firstHandle = executors.handle(first.snapshot.thread.id);
    const secondHandle = executors.handle(second.snapshot.thread.id);
    firstHandle.agentMessage(firstTurn.id, 'first answer');
    secondHandle.agentMessage(secondTurn.id, 'second answer');
    firstHandle.finish({ status: 'completed', usage: EMPTY_USAGE });
    secondHandle.finish({ status: 'completed', usage: EMPTY_USAGE });

    await vi.waitFor(async () => {
      expect((await first.runtime.snapshot()).thread.status).toBe('idle');
      expect((await second.runtime.snapshot()).thread.status).toBe('idle');
    });
    expect(JSON.stringify(await first.runtime.snapshot())).toContain(
      'first answer',
    );
    expect(JSON.stringify(await first.runtime.snapshot())).not.toContain(
      'second answer',
    );
  });

  it('同一 thread 同时只接受一个 active turn', async () => {
    const attachment = await startThread(manager, 'connection-1');
    await attachment.runtime.startTurn([{ type: 'text', text: 'first' }]);
    await expect(
      attachment.runtime.startTurn([{ type: 'text', text: 'second' }]),
    ).rejects.toMatchObject({ type: 'threadBusy' });
    executors.handle(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: EMPTY_USAGE,
    });
  });

  it('stale turn id 的 steer 与 interrupt 都 fail fast', async () => {
    const attachment = await startThread(manager, 'connection-1');
    await attachment.runtime.startTurn([{ type: 'text', text: 'first' }]);
    await expect(
      attachment.runtime.steerTurn('turn_stale', [
        { type: 'text', text: 'steer' },
      ]),
    ).rejects.toMatchObject({ type: 'turnMismatch' });
    await expect(
      attachment.runtime.interruptTurn('turn_stale'),
    ).rejects.toMatchObject({ type: 'turnMismatch' });
    executors.handle(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: EMPTY_USAGE,
    });
  });

  it('fork 生成新 thread、turn 和 item id，原 thread 不变', async () => {
    const source = await startThread(manager, 'connection-1');
    const turn = await source.runtime.startTurn([
      { type: 'text', text: 'source' },
    ]);
    const handle = executors.handle(source.snapshot.thread.id);
    handle.agentMessage(turn.id, 'answer');
    handle.finish({ status: 'completed', usage: EMPTY_USAGE });
    await vi.waitFor(async () => {
      expect((await source.runtime.snapshot()).thread.status).toBe('idle');
    });
    await logs.append(source.snapshot.thread.id, {
      kind: 'transcript.entry',
      turnId: turn.id,
      role: 'user',
      message: { role: 'user', content: 'source model history' },
    });
    const sourceGoal = await manager.setGoal(source.snapshot.thread.id, {
      objective: 'finish the forked work',
      tokenBudget: 1_000,
    });
    const sourceSnapshot = await source.runtime.snapshot();
    const fork = await manager.fork(
      'connection-2',
      {
        threadId: sourceSnapshot.thread.id,
        lastTurnId: turn.id,
        subscribe: true,
      },
      () => undefined,
    );

    expect(fork.snapshot.thread.id).not.toBe(sourceSnapshot.thread.id);
    expect(fork.snapshot.thread.forkedFromId).toBe(sourceSnapshot.thread.id);
    expect(fork.snapshot.turns[0]?.id).not.toBe(sourceSnapshot.turns[0]?.id);
    expect(fork.snapshot.turns[0]?.items[0]?.id).not.toBe(
      sourceSnapshot.turns[0]?.items[0]?.id,
    );
    expect(
      await new ThreadTranscriptStore(logs).load(fork.snapshot.thread.id),
    ).toEqual([{ role: 'user', content: 'source model history' }]);
    expect(fork.snapshot.goal).toMatchObject({
      objective: sourceGoal.objective,
      status: 'paused',
      tokenBudget: sourceGoal.tokenBudget,
    });
    expect(fork.snapshot.goal?.id).not.toBe(sourceGoal.id);
    expect(await source.runtime.snapshot()).toEqual(sourceSnapshot);
  });

  it('Thread usage 累加多个 Turn，单个 Turn 保留自身 usage', async () => {
    const attachment = await startThread(manager, 'connection-usage');
    const firstUsage: Usage = {
      requests: 2,
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      toolCalls: 1,
    };
    const secondUsage: Usage = {
      requests: 3,
      inputTokens: 30,
      outputTokens: 7,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
      toolCalls: 2,
    };

    await attachment.runtime.startTurn([{ type: 'text', text: 'first' }]);
    executors.handle(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: firstUsage,
    });
    await vi.waitFor(async () => {
      expect((await attachment.runtime.snapshot()).thread.status).toBe('idle');
    });
    await attachment.runtime.startTurn([{ type: 'text', text: 'second' }]);
    executors.handle(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: secondUsage,
    });
    await vi.waitFor(async () => {
      expect((await attachment.runtime.snapshot()).turns).toHaveLength(2);
      expect((await attachment.runtime.snapshot()).thread.status).toBe('idle');
    });

    const snapshot = await attachment.runtime.snapshot();
    expect(snapshot.turns.map((turn) => turn.usage)).toEqual([
      firstUsage,
      secondUsage,
    ]);
    expect(snapshot.usage).toEqual({
      requests: 5,
      inputTokens: 50,
      outputTokens: 12,
      cacheReadTokens: 10,
      cacheWriteTokens: 3,
      toolCalls: 3,
    });
  });

  it('活动 Goal 按非缓存 token 累计，并在预算耗尽时暂停', async () => {
    const attachment = await startThread(manager, 'connection-goal-usage');
    await attachment.runtime.setGoal({
      objective: '按预算完成',
      tokenBudget: 30,
    });
    await attachment.runtime.startTurn([{ type: 'text', text: 'work' }]);
    executors.handle(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: {
        requests: 1,
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        toolCalls: 0,
      },
    });

    await vi.waitFor(async () => {
      expect((await attachment.runtime.snapshot()).goal).toMatchObject({
        status: 'paused',
        tokensUsed: 30,
      });
    });
  });

  it('Goal 目标规范化空白并拒绝空值与超长输入', async () => {
    const attachment = await startThread(manager, 'connection-goal-input');
    await expect(
      attachment.runtime.setGoal({ objective: '   ' }),
    ).rejects.toMatchObject({ type: 'invalidParams' });
    await expect(
      attachment.runtime.setGoal({ objective: 'x'.repeat(4_001) }),
    ).rejects.toMatchObject({ type: 'invalidParams' });
    await expect(
      attachment.runtime.setGoal({ objective: '  完成真实目标  ' }),
    ).resolves.toMatchObject({ objective: '完成真实目标' });
  });

  it('Goal 工具终态事件先持久化，Turn 最终用量仍归入同一 Goal', async () => {
    const attachment = await startThread(manager, 'connection-goal-event');
    const goal = await attachment.runtime.setGoal({ objective: '完成工作' });
    await attachment.runtime.startTurn([{ type: 'text', text: 'finish' }]);
    const handle = executors.handle(attachment.snapshot.thread.id);
    handle.emit({
      type: 'goalUpdated',
      goal: {
        ...goal,
        status: 'complete',
        updatedAt: new Date().toISOString(),
      },
    });
    handle.finish({
      status: 'completed',
      usage: {
        requests: 1,
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        toolCalls: 1,
      },
    });

    await vi.waitFor(async () => {
      expect((await attachment.runtime.snapshot()).goal).toMatchObject({
        id: goal.id,
        status: 'complete',
        tokensUsed: 15,
      });
    });
  });

  it('thread/read 不加载 executor', async () => {
    const attachment = await startThread(manager, 'connection-1');
    const threadId = attachment.snapshot.thread.id;
    await manager.close();
    const readFactory = new FakeExecutorFactory();
    manager = new ThreadManager({
      root,
      logs,
      catalog: storage.threads,
      executorFactory: (snapshot) => readFactory.create(snapshot),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    await expect(
      manager.read({ threadId, includeTurns: true, includeItems: true }),
    ).resolves.toMatchObject({ thread: { id: threadId } });
    expect(readFactory.created).toBe(0);
  });

  it('无订阅 Thread 在 grace 后卸载 runtime 并释放 executor', async () => {
    const attachment = await manager.start('connection-detached', {
      ...startParams(),
      subscribe: false,
    });
    const threadId = attachment.snapshot.thread.id;

    await vi.waitFor(async () => expect(await manager.loaded()).toEqual([]));
    expect(executors.isClosed(threadId)).toBe(true);
    await expect(
      manager.read({ threadId, includeTurns: false, includeItems: false }),
    ).resolves.toMatchObject({ thread: { id: threadId } });
  });

  it('异步管理操作完成前持有 runtime，完成后再允许卸载', async () => {
    await manager.close();
    let resolverStarted = false;
    let releaseResolver: () => void = () => undefined;
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    manager = new ThreadManager({
      root,
      logs,
      catalog: storage.threads,
      executorFactory: (snapshot) => executors.create(snapshot),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: async (_snapshot, params) => {
        resolverStarted = true;
        await resolverGate;
        return testSettingsUpdate(params);
      },
      unloadGraceMs: 1,
    });
    await manager.initialize();
    const attachment = await startThread(manager, 'connection-held');
    const threadId = attachment.snapshot.thread.id;
    const update = manager.updateSettings('connection-update', {
      threadId,
      mode: 'accept-edits',
    });
    await vi.waitFor(() => expect(resolverStarted).toBe(true));
    await manager.unsubscribe('connection-held', threadId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await manager.loaded()).toHaveLength(1);
    releaseResolver();
    await expect(update).resolves.toMatchObject({ mode: 'accept-edits' });
    await vi.waitFor(async () => expect(await manager.loaded()).toEqual([]));
  });

  it('启动恢复把未完成 turn/item 标为 interrupted 并取消 pending request', async () => {
    await manager.close();
    const recoveryThreadId = 'thr_recovery';
    const recoveryTurnId = 'turn_recovery';
    const createdAt = new Date().toISOString();
    await logs.create(recoveryThreadId, {
      kind: 'thread.created',
      rootId: recoveryThreadId,
      cwd: '/workspace',
      name: 'recovery',
      settings: {
        mode: 'ask-before-changes',
        profile: 'main',
        model: 'test:model',
        agent: 'primary',
      },
      metadata: {},
    });
    await logs.append(recoveryThreadId, {
      kind: 'turn.started',
      turn: {
        id: recoveryTurnId,
        threadId: recoveryThreadId,
        status: 'inProgress',
        items: [],
        startedAt: createdAt,
      },
    });
    await logs.append(recoveryThreadId, {
      kind: 'item.started',
      turnId: recoveryTurnId,
      item: {
        type: 'userMessage',
        id: 'item_recovery_user',
        turnId: recoveryTurnId,
        createdAt,
        text: '  恢复旧会话\n预览  ',
      },
    });
    await logs.append(recoveryThreadId, {
      kind: 'item.completed',
      turnId: recoveryTurnId,
      item: {
        type: 'userMessage',
        id: 'item_recovery_user',
        turnId: recoveryTurnId,
        createdAt,
        text: '  恢复旧会话\n预览  ',
      },
    });
    await logs.append(recoveryThreadId, {
      kind: 'item.started',
      turnId: recoveryTurnId,
      item: {
        type: 'agentMessage',
        id: 'item_recovery',
        turnId: recoveryTurnId,
        createdAt,
        text: 'partial',
        phase: 'final',
        status: 'inProgress',
      },
    });
    await logs.append(recoveryThreadId, {
      kind: 'serverRequest.created',
      request: {
        id: 'srvreq_recovery',
        method: 'item/tool/requestUserInput',
        threadId: recoveryThreadId,
        turnId: recoveryTurnId,
        itemId: 'item_recovery',
        params: {},
        createdAt,
      },
    });
    const recoveryFactory = new FakeExecutorFactory();
    manager = new ThreadManager({
      root,
      logs,
      catalog: storage.threads,
      executorFactory: (snapshot) => recoveryFactory.create(snapshot),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    await manager.initialize();
    const snapshot = await manager.read({
      threadId: recoveryThreadId,
      includeTurns: true,
      includeItems: true,
    });
    expect(snapshot.thread.status).toBe('interrupted');
    expect(snapshot.thread.preview).toBe('恢复旧会话 预览');
    expect(snapshot.turns[0]?.status).toBe('interrupted');
    expect(
      snapshot.turns[0]?.items.find((item) => item.type === 'agentMessage'),
    ).toMatchObject({ status: 'failed' });
    expect(snapshot.pendingServerRequests).toEqual([]);
    expect(storage.threads.state(recoveryThreadId)?.seq).toBe(snapshot.seq);
    expect(recoveryFactory.created).toBe(0);
  });

  it('首个成功 Turn 生成并持久化标题，生成前使用用户输入 preview', async () => {
    await manager.close();
    const generatedSnapshots: ThreadSnapshot[] = [];
    const titleGenerator: ThreadTitleGenerator = {
      generate(snapshot) {
        generatedSnapshots.push(snapshot);
        return Promise.resolve('修复延迟审批响应');
      },
    };
    manager = new ThreadManager({
      root,
      logs,
      catalog: storage.threads,
      executorFactory: (snapshot) => executors.create(snapshot),
      titleGenerator,
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    await manager.initialize();
    const notifications: string[] = [];
    const attachment = await manager.start(
      'connection-title',
      {
        cwd: '/workspace',
        subscribe: true,
        metadata: {},
      },
      (notification) => {
        notifications.push(notification.method);
      },
    );
    await attachment.runtime.startTurn([
      { type: 'text', text: '  修复审批流程\n并补测试  ' },
    ]);
    expect((await attachment.runtime.snapshot()).thread).toMatchObject({
      name: '',
      preview: '修复审批流程 并补测试',
    });
    executors.handle(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: EMPTY_USAGE,
    });

    await vi.waitFor(async () => {
      expect((await attachment.runtime.snapshot()).thread.name).toBe(
        '修复延迟审批响应',
      );
    });
    expect(generatedSnapshots).toHaveLength(1);
    expect(generatedSnapshots[0]?.turns[0]?.status).toBe('completed');
    expect(notifications).toContain('thread/name/updated');
    expect(
      (await manager.list({ archived: false, limit: 50 })).data[0]?.name,
    ).toBe('修复延迟审批响应');

    const threadId = attachment.snapshot.thread.id;
    await manager.close();
    manager = new ThreadManager({
      root,
      logs,
      catalog: storage.threads,
      executorFactory: (snapshot) => executors.create(snapshot),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    await manager.initialize();
    await expect(
      manager.list({ archived: false, limit: 50 }),
    ).resolves.toMatchObject({
      data: [
        {
          id: threadId,
          name: '修复延迟审批响应',
          preview: '修复审批流程 并补测试',
        },
      ],
    });
  });

  it('标题生成失败不改变 Turn 成功终态', async () => {
    await manager.close();
    let attempted = false;
    manager = new ThreadManager({
      root,
      logs,
      catalog: storage.threads,
      executorFactory: (snapshot) => executors.create(snapshot),
      titleGenerator: {
        generate() {
          attempted = true;
          return Promise.reject(new Error('title provider unavailable'));
        },
      },
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    await manager.initialize();
    const attachment = await manager.start('connection-title-failure', {
      cwd: '/workspace',
      subscribe: false,
      metadata: {},
    });
    await attachment.runtime.startTurn([
      { type: 'text', text: '仍应成功完成的任务' },
    ]);
    executors.handle(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: EMPTY_USAGE,
    });

    await vi.waitFor(async () => {
      expect(attempted).toBe(true);
      expect((await attachment.runtime.snapshot()).turns[0]?.status).toBe(
        'completed',
      );
    });
    expect((await attachment.runtime.snapshot()).thread).toMatchObject({
      name: '',
      preview: '仍应成功完成的任务',
      status: 'idle',
    });
  });

  it('启动时跳过其他 Server 持有的活跃 Thread', async () => {
    const attachment = await startThread(manager, 'connection-owner');
    const threadId = attachment.snapshot.thread.id;
    const secondStorage = createCodingStorage({
      databasePath: join(root, 'state.sqlite'),
      artifactsDir: join(root, 'artifacts'),
    });
    const secondManager = new ThreadManager({
      root,
      logs: new ThreadLogRepository({ root }),
      catalog: secondStorage.threads,
      executorFactory: (snapshot) => executors.create(snapshot),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    try {
      await expect(secondManager.initialize()).resolves.toBeUndefined();
      await expect(
        secondManager.list({ archived: false, limit: 50 }),
      ).resolves.toMatchObject({ data: [{ id: threadId }] });
      await expect(
        secondManager.resume(
          'connection-contender',
          { threadId, subscribe: false },
          undefined,
        ),
      ).rejects.toMatchObject({
        type: 'threadBusy',
        message: expect.stringContaining('Another Ello session'),
      });
    } finally {
      await secondManager.close();
      secondStorage.close();
    }
  });

  it('thread/list 只查询 SQLite catalog，不重放 JSONL', async () => {
    const attachment = await startThread(manager, 'connection-1');
    const read = vi.spyOn(logs, 'read');

    await expect(
      manager.list({ archived: false, limit: 50 }),
    ).resolves.toMatchObject({
      data: [{ id: attachment.snapshot.thread.id }],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('archive、unarchive 和 delete 同步 catalog', async () => {
    const attachment = await startThread(manager, 'connection-1');
    const threadId = attachment.snapshot.thread.id;

    await expect(manager.archive(threadId)).resolves.toMatchObject({
      id: threadId,
      archived: true,
      status: 'archived',
    });
    expect(storage.threads.state(threadId)?.archived).toBe(true);
    await expect(manager.unarchive(threadId)).resolves.toMatchObject({
      id: threadId,
      archived: false,
      status: 'idle',
    });
    expect(storage.threads.state(threadId)?.archived).toBe(false);
    await manager.deleteAny(threadId);
    expect(storage.threads.state(threadId)).toBeNull();
  });

  it('启动时重建偏离 catalog 并删除孤儿目录', async () => {
    const attachment = await startThread(manager, 'connection-1');
    const threadId = attachment.snapshot.thread.id;
    await manager.close();
    storage.threads.delete(threadId);
    storage.threads.apply(
      parseThreadRecord(
        {
          kind: 'thread.created',
          schema: 1,
          seq: 1,
          threadId: 'thr_orphan',
          createdAt: new Date().toISOString(),
          rootId: 'thr_orphan',
          cwd: '/workspace',
          name: 'orphan',
          settings: {
            mode: 'ask-before-changes',
            profile: 'main',
            model: 'test:model',
            agent: 'primary',
          },
          metadata: {},
        },
        'test orphan',
      ),
    );

    manager = new ThreadManager({
      root,
      logs,
      catalog: storage.threads,
      executorFactory: (snapshot) => executors.create(snapshot),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    await manager.initialize();

    expect(storage.threads.state(threadId)).toMatchObject({
      id: threadId,
      seq: 1,
    });
    expect(storage.threads.state('thr_orphan')).toBeNull();
  });

  it('通知发布时对应 record 已经写入 JSONL', async () => {
    const notifications: string[] = [];
    let persistedAtNotification = false;
    let catalogAtNotification = false;
    const attachment = await manager.start(
      'connection-1',
      startParams(),
      async (notification) => {
        notifications.push(notification.method);
        const params = notification.params as Partial<{
          readonly threadId: string;
          readonly seq: number;
        }>;
        if (params.threadId === undefined || params.seq === undefined) return;
        const content = await readFile(
          threadLogPath(params.threadId, root),
          'utf8',
        );
        persistedAtNotification = content.includes(`"seq":${params.seq}`);
        catalogAtNotification =
          storage.threads.state(params.threadId)?.seq === params.seq;
      },
    );
    await attachment.runtime.startTurn([{ type: 'text', text: 'hello' }]);
    await vi.waitFor(() => {
      expect(notifications).toContain('turn/started');
      expect(persistedAtNotification).toBe(true);
      expect(catalogAtNotification).toBe(true);
    });
    expect(persistedAtNotification).toBe(true);
    expect(catalogAtNotification).toBe(true);
    executors.handle(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: EMPTY_USAGE,
    });
  });

  it('Server Request 只接受第一条 response', async () => {
    const attachment = await startThread(manager, 'connection-1');
    const turn = await attachment.runtime.startTurn([
      { type: 'text', text: 'approval' },
    ]);
    const handle = executors.handle(attachment.snapshot.thread.id);
    handle.emit({
      type: 'serverRequest',
      request: {
        id: 'srvreq_test',
        method: 'item/commandExecution/requestApproval',
        threadId: attachment.snapshot.thread.id,
        turnId: turn.id,
        itemId: 'item_approval',
        params: {},
        createdAt: new Date().toISOString(),
      },
    });
    await vi.waitFor(async () => {
      expect(
        (await attachment.runtime.snapshot()).pendingServerRequests,
      ).toHaveLength(1);
    });
    await attachment.runtime.resolveServerRequest('srvreq_test', {
      decision: 'accept',
    });
    await expect(
      attachment.runtime.resolveServerRequest('srvreq_test', {
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ type: 'requestResolved' });
    expect(handle.resolutions).toEqual(['srvreq_test']);
    handle.finish({ status: 'completed', usage: EMPTY_USAGE });
  });

  it('Server Request controller 失败后转交下一个订阅者', async () => {
    const controllers: string[] = [];
    const attachment = await manager.start(
      'connection-controller-1',
      startParams(),
      () => undefined,
      () => {
        controllers.push('first');
        return Promise.reject(new Error('controller disconnected'));
      },
    );
    await manager.resume(
      'connection-controller-2',
      { threadId: attachment.snapshot.thread.id, subscribe: true },
      () => undefined,
      () => {
        controllers.push('second');
        return Promise.resolve({ decision: 'accept' });
      },
    );
    const turn = await attachment.runtime.startTurn([
      { type: 'text', text: 'approval' },
    ]);
    const handle = executors.handle(attachment.snapshot.thread.id);
    handle.emit({
      type: 'serverRequest',
      request: {
        id: 'srvreq_failover',
        method: 'item/commandExecution/requestApproval',
        threadId: attachment.snapshot.thread.id,
        turnId: turn.id,
        itemId: 'item_approval',
        params: {},
        createdAt: new Date().toISOString(),
      },
    });

    await vi.waitFor(() =>
      expect(handle.resolutions).toEqual(['srvreq_failover']),
    );
    expect(controllers).toEqual(['first', 'second']);
    handle.finish({ status: 'completed', usage: EMPTY_USAGE });
  });
});

function startThread(manager: ThreadManager, connectionId: string) {
  return manager.start(connectionId, startParams(), () => undefined);
}

function startParams() {
  return {
    cwd: '/workspace',
    name: 'test',
    subscribe: true,
    metadata: {},
  } as const;
}

class FakeExecutorFactory {
  created = 0;
  private readonly executors = new Map<string, FakeExecutor>();

  create(snapshot: ThreadSnapshot): Promise<TurnExecutor> {
    this.created += 1;
    const executor = new FakeExecutor();
    this.executors.set(snapshot.thread.id, executor);
    return Promise.resolve(executor);
  }

  handle(threadId: string): FakeExecutionHandle {
    const handle = this.executors.get(threadId)?.lastHandle;
    if (handle === undefined) throw new Error(`No handle for ${threadId}.`);
    return handle;
  }

  isClosed(threadId: string): boolean {
    return this.executors.get(threadId)?.closed === true;
  }
}

class FakeExecutor implements TurnExecutor {
  lastHandle: FakeExecutionHandle | undefined;
  closed = false;

  start(): Promise<TurnExecutionHandle> {
    this.lastHandle = new FakeExecutionHandle();
    return Promise.resolve(this.lastHandle);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeExecutionHandle implements TurnExecutionHandle {
  readonly resolutions: string[] = [];
  readonly events: AsyncIterable<TurnExecutionEvent>;
  readonly final: Promise<TurnExecutionResult>;
  private readonly queue = new EventQueue();
  private readonly resolveFinal: (result: TurnExecutionResult) => void;
  private settled = false;

  constructor() {
    this.events = this.queue;
    let resolveFinal: (result: TurnExecutionResult) => void = () => undefined;
    this.final = new Promise((resolve) => {
      resolveFinal = resolve;
    });
    this.resolveFinal = resolveFinal;
  }

  emit(event: TurnExecutionEvent): void {
    this.queue.push(event);
  }

  agentMessage(turnId: string, text: string): void {
    const itemId = `item_${text.replaceAll(' ', '_')}`;
    const createdAt = new Date().toISOString();
    this.emit({
      type: 'itemStarted',
      item: {
        type: 'agentMessage',
        id: itemId,
        turnId,
        createdAt,
        text: '',
        phase: 'final',
        status: 'inProgress',
      },
    });
    this.emit({
      type: 'itemDelta',
      itemId,
      delta: { type: 'agentMessage', text },
    });
    this.emit({
      type: 'itemCompleted',
      item: {
        type: 'agentMessage',
        id: itemId,
        turnId,
        createdAt,
        text,
        phase: 'final',
        status: 'completed',
      },
    });
  }

  finish(result: TurnExecutionResult): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.end();
    this.resolveFinal(result);
  }

  steer(_input: readonly UserInput[]): Promise<void> {
    return Promise.resolve();
  }

  interrupt(reason: string): Promise<void> {
    this.finish({ status: 'interrupted', usage: EMPTY_USAGE, reason });
    return Promise.resolve();
  }

  resolveServerRequest(requestId: string): Promise<void> {
    this.resolutions.push(requestId);
    return Promise.resolve();
  }

  rejectServerRequest(): Promise<void> {
    return Promise.resolve();
  }
}

class EventQueue implements AsyncIterable<TurnExecutionEvent> {
  private readonly values: TurnExecutionEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<TurnExecutionEvent>) => void
  > = [];
  private ended = false;

  [Symbol.asyncIterator](): AsyncIterator<TurnExecutionEvent> {
    return { next: () => this.next() };
  }

  push(event: TurnExecutionEvent): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(event);
    else waiter({ done: false, value: event });
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  private next(): Promise<IteratorResult<TurnExecutionEvent>> {
    const event = this.values.shift();
    if (event !== undefined)
      return Promise.resolve({ done: false, value: event });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
