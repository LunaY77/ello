/**
 * 本文件验证 thread-manager 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRun,
  AgentRunEvent,
  AgentRunResult,
  AgentRunRequest,
} from '../../src/features/agent/index.js';
import { compactionView } from '../../src/features/thread/compact.js';
import {
  createThreadFeature,
  createThreadStore,
  type ThreadFeature,
  type ThreadStore,
} from '../../src/features/thread/index.js';
import type { ThreadTitleGenerator } from '../../src/features/thread/title.js';
import { threadLogPath } from '../../src/infra/paths.js';
import type {
  ParsedClientParams,
  ThreadSnapshot,
  Usage,
} from '../../src/protocol/v1/index.js';
import { parseThreadRecord } from '../../src/storage/threads/thread-record.js';
import { createTestStores, type TestStores } from '../support/stores.js';

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

describe('ThreadFeature', () => {
  let root: string;
  let storage: TestStores;
  let logs: ThreadStore;
  let agent: FakeAgent;
  let manager: ThreadFeature;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-thread-manager-'));
    storage = createTestStores({
      databasePath: join(root, 'state.sqlite'),
      artifactsDir: join(root, 'artifacts'),
    });
    logs = createThreadStore({ root, database: storage.db });
    agent = new FakeAgent();
    manager = createThreadFeature({
      store: logs,
      startAgentRun: (input) => agent.startRun(input),
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
    const firstHandle = agent.run(first.snapshot.thread.id);
    const secondHandle = agent.run(second.snapshot.thread.id);
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
    agent.run(attachment.snapshot.thread.id).finish({
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
    agent.run(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: EMPTY_USAGE,
    });
  });

  it('fork 生成新 thread、turn 和 item id，原 thread 不变', async () => {
    const source = await startThread(manager, 'connection-1');
    const turn = await source.runtime.startTurn([
      { type: 'text', text: 'source' },
    ]);
    const handle = agent.run(source.snapshot.thread.id);
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
      compactionView(await logs.read(fork.snapshot.thread.id))
        .projectedMessages,
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
    agent.run(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: firstUsage,
    });
    await vi.waitFor(async () => {
      expect((await attachment.runtime.snapshot()).thread.status).toBe('idle');
    });
    await attachment.runtime.startTurn([{ type: 'text', text: 'second' }]);
    agent.run(attachment.snapshot.thread.id).finish({
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
    agent.run(attachment.snapshot.thread.id).finish({
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
    const handle = agent.run(attachment.snapshot.thread.id);
    handle.emit({
      type: 'toolStarted',
      toolCallId: 'item_goal_update',
      name: 'update_goal',
      input: { status: 'complete' },
      occurredAt: new Date().toISOString(),
    });
    handle.emit({
      type: 'toolCompleted',
      toolCallId: 'item_goal_update',
      output: {
        kind: 'thread-goal-updated',
        goal: {
          ...goal,
          status: 'complete',
          updatedAt: new Date().toISOString(),
        },
      },
      occurredAt: new Date().toISOString(),
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
    const readAgent = new FakeAgent();
    manager = createThreadFeature({
      store: logs,
      startAgentRun: (input) => readAgent.startRun(input),
      unloadGraceMs: 30_000,
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    await expect(
      manager.read({ threadId, includeTurns: true, includeItems: true }),
    ).resolves.toMatchObject({ thread: { id: threadId } });
    expect(readAgent.started).toBe(0);
  });

  it('无订阅 Thread 在 grace 后卸载 runtime 并释放 executor', async () => {
    const attachment = await manager.start('connection-detached', {
      ...startParams(),
      subscribe: false,
    });
    const threadId = attachment.snapshot.thread.id;

    await vi.waitFor(async () => expect(await manager.loaded()).toEqual([]));
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
    manager = createThreadFeature({
      store: logs,
      startAgentRun: (input) => agent.startRun(input),
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
    const crashedThread = await logs.create(recoveryThreadId, {
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
    await crashedThread.lease.release();
    const recoveryAgent = new FakeAgent();
    manager = createThreadFeature({
      store: logs,
      startAgentRun: (input) => recoveryAgent.startRun(input),
      unloadGraceMs: 30_000,
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
    expect(recoveryAgent.started).toBe(0);
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
    manager = createThreadFeature({
      store: logs,
      startAgentRun: (input) => agent.startRun(input),
      unloadGraceMs: 30_000,
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
        name: '',
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
    agent.run(attachment.snapshot.thread.id).finish({
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
    manager = createThreadFeature({
      store: logs,
      startAgentRun: (input) => agent.startRun(input),
      unloadGraceMs: 30_000,
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
    manager = createThreadFeature({
      store: logs,
      startAgentRun: (input) => agent.startRun(input),
      unloadGraceMs: 30_000,
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
      name: '',
      subscribe: false,
      metadata: {},
    });
    await attachment.runtime.startTurn([
      { type: 'text', text: '仍应成功完成的任务' },
    ]);
    agent.run(attachment.snapshot.thread.id).finish({
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
    const secondStorage = createTestStores({
      databasePath: join(root, 'state.sqlite'),
      artifactsDir: join(root, 'artifacts'),
    });
    const secondThreadStore = createThreadStore({
      root,
      database: secondStorage.db,
    });
    const secondManager = createThreadFeature({
      store: secondThreadStore,
      startAgentRun: (input) => agent.startRun(input),
      unloadGraceMs: 30_000,
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
    await manager.delete(threadId);
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

    manager = createThreadFeature({
      store: logs,
      startAgentRun: (input) => agent.startRun(input),
      unloadGraceMs: 30_000,
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
    agent.run(attachment.snapshot.thread.id).finish({
      status: 'completed',
      usage: EMPTY_USAGE,
    });
  });

  it('Server Request 只接受第一条 response', async () => {
    const attachment = await startThread(manager, 'connection-1');
    await attachment.runtime.startTurn([{ type: 'text', text: 'approval' }]);
    const handle = agent.run(attachment.snapshot.thread.id);
    handle.emit({
      type: 'interactionRequired',
      interaction: {
        type: 'approval',
        interactionId: 'item_approval',
        item: {
          kind: 'approval',
          toolCallId: 'item_approval',
          toolName: 'bash',
          input: { command: 'pwd' },
          metadata: {
            request: { kind: 'shell', command: 'pwd', cwd: '/workspace' },
          },
        },
        occurredAt: new Date().toISOString(),
      },
    });
    await vi.waitFor(async () => {
      expect(
        (await attachment.runtime.snapshot()).pendingServerRequests,
      ).toHaveLength(1);
    });
    const requestId = (await attachment.runtime.snapshot())
      .pendingServerRequests[0]?.id;
    if (requestId === undefined) throw new Error('Missing Server Request.');
    await attachment.runtime.resolveServerRequest(requestId, {
      decision: 'accept',
    });
    await expect(
      attachment.runtime.resolveServerRequest(requestId, {
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ type: 'requestResolved' });
    expect(handle.resolutions).toEqual(['item_approval']);
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
    await attachment.runtime.startTurn([{ type: 'text', text: 'approval' }]);
    const handle = agent.run(attachment.snapshot.thread.id);
    handle.emit({
      type: 'interactionRequired',
      interaction: {
        type: 'approval',
        interactionId: 'item_approval',
        item: {
          kind: 'approval',
          toolCallId: 'item_approval',
          toolName: 'bash',
          input: { command: 'pwd' },
          metadata: {
            request: { kind: 'shell', command: 'pwd', cwd: '/workspace' },
          },
        },
        occurredAt: new Date().toISOString(),
      },
    });

    await vi.waitFor(() =>
      expect(handle.resolutions).toEqual(['item_approval']),
    );
    expect(controllers).toEqual(['first', 'second']);
    handle.finish({ status: 'completed', usage: EMPTY_USAGE });
  });

  it('全部 Server Request controller 失败时拒绝 pending interaction', async () => {
    const attachment = await manager.start(
      'connection-controller-failed',
      startParams(),
      () => undefined,
      () => Promise.reject(new Error('controller disconnected')),
    );
    await attachment.runtime.startTurn([{ type: 'text', text: 'approval' }]);
    const handle = agent.run(attachment.snapshot.thread.id);
    handle.emit({
      type: 'interactionRequired',
      interaction: {
        type: 'approval',
        interactionId: 'item_approval_failed',
        item: {
          kind: 'approval',
          toolCallId: 'item_approval_failed',
          toolName: 'bash',
          input: { command: 'pwd' },
          metadata: {
            request: { kind: 'shell', command: 'pwd', cwd: '/workspace' },
          },
        },
        occurredAt: new Date().toISOString(),
      },
    });

    await vi.waitFor(() => expect(handle.rejections).toHaveLength(1));
    expect(handle.rejections[0]).toMatchObject({
      interactionId: 'item_approval_failed',
      error: { message: 'controller disconnected' },
    });
    await vi.waitFor(async () => {
      expect(
        (await attachment.runtime.snapshot()).pendingServerRequests,
      ).toEqual([]);
    });
  });
});

function startThread(manager: ThreadFeature, connectionId: string) {
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

class FakeAgent {
  started = 0;
  private readonly runs = new Map<string, FakeAgentRun>();

  /**
   * 为一次稳定请求启动独立 Agent run，并把事件流与最终结果的观察权交给调用方。
   *
   * Args:
   * - `input`: `startRun` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 兑现为独立 `AgentRun`；其事件流与 `result` 覆盖该运行的完整生命周期。
   *
   * Throws:
   * - 当 测试夹具的 `thread-manager.test` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  startRun(input: AgentRunRequest): Promise<AgentRun> {
    this.started += 1;
    const run = new FakeAgentRun();
    this.runs.set(input.threadId, run);
    return Promise.resolve(run);
  }

  run(threadId: string): FakeAgentRun {
    const run = this.runs.get(threadId);
    if (run === undefined) throw new Error(`No Agent run for ${threadId}.`);
    return run;
  }
}

class FakeAgentRun implements AgentRun {
  readonly resolutions: string[] = [];
  readonly rejections: Array<
    Extract<Parameters<AgentRun['resume']>[0], { type: 'rejected' }>
  > = [];
  readonly events: AsyncIterable<AgentRunEvent>;
  readonly result: Promise<AgentRunResult>;
  private readonly queue = new EventQueue();
  private readonly resolveResult: (result: AgentRunResult) => void;
  private settled = false;

  constructor() {
    this.events = this.queue;
    let resolveResult: ((result: AgentRunResult) => void) | undefined;
    this.result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    if (resolveResult === undefined) {
      throw new Error('Fake Agent run did not initialize its result resolver.');
    }
    this.resolveResult = resolveResult;
  }

  emit(event: AgentRunEvent): void {
    this.queue.push(event);
  }

  agentMessage(_turnId: string, text: string): void {
    const itemId = `item_${text.replaceAll(' ', '_')}`;
    const createdAt = new Date().toISOString();
    this.emit({
      type: 'messageStarted',
      messageId: itemId,
      occurredAt: createdAt,
    });
    this.emit({
      type: 'messageDelta',
      messageId: itemId,
      text,
    });
    this.emit({
      type: 'messageCompleted',
      messageId: itemId,
      text,
    });
  }

  finish(result: AgentRunResult): void {
    if (this.settled) return;
    this.settled = true;
    this.queue.end();
    this.resolveResult(result);
  }

  steer(_input: string): void {}

  interrupt(reason: string): void {
    this.finish({ status: 'interrupted', usage: EMPTY_USAGE, reason });
  }

  resume(resolution: Parameters<AgentRun['resume']>[0]): void {
    switch (resolution.type) {
      case 'approval':
      case 'toolResult':
        this.resolutions.push(resolution.interactionId);
        return;
      case 'rejected':
        this.rejections.push(resolution);
        this.finish({
          status: 'failed',
          usage: EMPTY_USAGE,
          error: {
            code: String(resolution.error.code),
            message: resolution.error.message,
          },
        });
        return;
      default:
        resolution satisfies never;
        throw new Error(`Unhandled Agent resolution: ${String(resolution)}`);
    }
  }
}

class EventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly values: AgentRunEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<AgentRunEvent>) => void
  > = [];
  private ended = false;

  [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
    return { next: () => this.next() };
  }

  push(event: AgentRunEvent): void {
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

  private next(): Promise<IteratorResult<AgentRunEvent>> {
    const event = this.values.shift();
    if (event !== undefined)
      return Promise.resolve({ done: false, value: event });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
