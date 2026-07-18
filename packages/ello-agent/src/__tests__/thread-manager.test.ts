import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TurnExecutionEvent,
  TurnExecutionHandle,
  TurnExecutionResult,
  TurnExecutor,
} from '../domain/ports/turn-executor.js';
import type {
  ParsedClientParams,
  ThreadSnapshot,
  Usage,
  UserInput,
} from '../protocol/v1/index.js';
import { ThreadManager } from '../server/runtime/thread-manager.js';
import {
  createCodingStorage,
  type CodingStorage,
} from '../storage/database/index.js';
import { threadLogPath } from '../storage/paths.js';
import { ThreadLogRepository } from '../storage/threads/thread-log.js';
import { parseThreadRecord } from '../storage/threads/thread-record.js';

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
      resolveSettingsUpdate: (_snapshot, params) => Promise.resolve(params),
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
    expect(await source.runtime.snapshot()).toEqual(sourceSnapshot);
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
      resolveSettingsUpdate: (_snapshot, params) => Promise.resolve(params),
    });
    await expect(
      manager.read({ threadId, includeTurns: true, includeItems: true }),
    ).resolves.toMatchObject({ thread: { id: threadId } });
    expect(readFactory.created).toBe(0);
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
      resolveSettingsUpdate: (_snapshot, params) => Promise.resolve(params),
    });
    await manager.initialize();
    const snapshot = await manager.read({
      threadId: recoveryThreadId,
      includeTurns: true,
      includeItems: true,
    });
    expect(snapshot.thread.status).toBe('interrupted');
    expect(snapshot.turns[0]?.status).toBe('interrupted');
    expect(snapshot.turns[0]?.items[0]).toMatchObject({ status: 'failed' });
    expect(snapshot.pendingServerRequests).toEqual([]);
    expect(storage.threads.state(recoveryThreadId)?.seq).toBe(snapshot.seq);
    expect(recoveryFactory.created).toBe(0);
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
      resolveSettingsUpdate: (_snapshot, params) => Promise.resolve(params),
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
        const content = await readFile(
          threadLogPath(notification.params.threadId, root),
          'utf8',
        );
        persistedAtNotification = content.includes(
          `"seq":${notification.params.seq}`,
        );
        catalogAtNotification =
          storage.threads.state(notification.params.threadId)?.seq ===
          notification.params.seq;
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
