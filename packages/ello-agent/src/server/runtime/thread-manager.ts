import { createEntityId } from '../../domain/ids.js';
import type { TurnExecutorFactory } from '../../domain/ports/turn-executor.js';
import { projectThreadSnapshot } from '../../domain/projection/thread-snapshot.js';
import {
  AppServerError,
  type ParsedClientParams,
  type ThreadSnapshot,
  type ThreadSummary,
  type Turn,
  type UserInput,
  type Goal,
  type Plan,
} from '../../protocol/v1/index.js';
import type { ThreadCatalogRepository } from '../../storage/repositories/thread-catalog-repository.js';
import { ThreadLeaseStore } from '../../storage/threads/thread-lease.js';
import { ThreadLogRepository } from '../../storage/threads/thread-log.js';
import type {
  NewThreadRecord,
  ThreadRecord,
} from '../../storage/threads/thread-record.js';

import type {
  ServerRequestListener,
  SubscriptionListener,
} from './subscription-hub.js';
import { recoverInterruptedThreads } from './thread-recovery.js';
import { ThreadRuntime } from './thread-runtime.js';

interface ThreadEntry {
  readonly runtime: ThreadRuntime;
  readonly subscriptions: Map<string, () => void>;
  holds: number;
  unloadTimer: NodeJS.Timeout | undefined;
}

export interface ThreadManagerOptions {
  readonly root: string;
  readonly executorFactory: TurnExecutorFactory;
  readonly catalog: ThreadCatalogRepository;
  readonly logs?: ThreadLogRepository;
  readonly unloadGraceMs?: number;
  resolveInitialSettings(
    params: ParsedClientParams<'thread/start'>,
  ): Promise<ThreadSnapshot['settings']>;
  resolveSettingsUpdate(
    snapshot: ThreadSnapshot,
    params: Omit<ParsedClientParams<'thread/settings/update'>, 'threadId'>,
  ): Promise<Partial<ThreadSnapshot['settings']>>;
}

export interface ThreadAttachment {
  readonly runtime: ThreadRuntime;
  readonly snapshot: ThreadSnapshot;
}

/** process-scoped Thread registry，也是创建、恢复、fork 的唯一入口。 */
export class ThreadManager {
  private readonly logs: ThreadLogRepository;
  private readonly catalog: ThreadCatalogRepository;
  private readonly leases: ThreadLeaseStore;
  private readonly executorFactory: TurnExecutorFactory;
  private readonly resolveInitialSettings: ThreadManagerOptions['resolveInitialSettings'];
  private readonly resolveSettingsUpdate: ThreadManagerOptions['resolveSettingsUpdate'];
  private readonly unloadGraceMs: number;
  private readonly entries = new Map<string, ThreadEntry>();
  private readonly loading = new Map<string, Promise<ThreadEntry>>();
  private stopping = false;

  constructor(options: ThreadManagerOptions) {
    this.logs = options.logs ?? new ThreadLogRepository({ root: options.root });
    this.catalog = options.catalog;
    this.leases = new ThreadLeaseStore(options.root);
    this.executorFactory = options.executorFactory;
    this.resolveInitialSettings = options.resolveInitialSettings;
    this.resolveSettingsUpdate = options.resolveSettingsUpdate;
    this.unloadGraceMs = options.unloadGraceMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    await this.logs.initialize();
    await recoverInterruptedThreads({ logs: this.logs, leases: this.leases });
    await this.reconcileCatalog();
  }

  async start(
    connectionId: string,
    params: ParsedClientParams<'thread/start'>,
    listener?: SubscriptionListener,
    requestListener?: ServerRequestListener,
  ): Promise<ThreadAttachment> {
    this.assertRunning();
    assertListener(params.subscribe, listener);
    const threadId = createEntityId('thr');
    const lease = await this.leases.acquire(threadId);
    try {
      const settings = await this.resolveInitialSettings(params);
      const created = await this.logs.create(threadId, {
        kind: 'thread.created',
        rootId: threadId,
        cwd: params.cwd,
        name: params.name ?? '',
        settings,
        metadata: params.metadata ?? {},
      });
      this.catalog.apply(created);
      const snapshot = projectThreadSnapshot([created]);
      const executor = await this.executorFactory(snapshot);
      const runtime = new ThreadRuntime({
        records: [created],
        logs: this.logs,
        catalog: this.catalog,
        executor,
        lease,
      });
      const entry: ThreadEntry = {
        runtime,
        subscriptions: new Map(),
        holds: 0,
        unloadTimer: undefined,
      };
      this.entries.set(threadId, entry);
      this.attach(
        entry,
        connectionId,
        params.subscribe,
        listener,
        requestListener,
      );
      const attachedSnapshot = await runtime.snapshot();
      this.scheduleUnload(threadId, entry);
      return { runtime, snapshot: attachedSnapshot };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async updateSettings(
    _connectionId: string,
    params: ParsedClientParams<'thread/settings/update'>,
  ): Promise<ThreadSnapshot['settings']> {
    return this.withEntry(params.threadId, true, async (entry) => {
      const snapshot = await entry.runtime.snapshot();
      const update = await this.resolveSettingsUpdate(snapshot, {
        ...(params.mode === undefined ? {} : { mode: params.mode }),
        ...(params.profile === undefined ? {} : { profile: params.profile }),
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.agent === undefined ? {} : { agent: params.agent }),
      });
      return entry.runtime.updateSettings(update);
    });
  }

  async resume(
    connectionId: string,
    params: ParsedClientParams<'thread/resume'>,
    listener?: SubscriptionListener,
    requestListener?: ServerRequestListener,
  ): Promise<ThreadAttachment> {
    this.assertRunning();
    assertListener(params.subscribe, listener);
    const entry = await this.load(params.threadId);
    this.attach(
      entry,
      connectionId,
      params.subscribe,
      listener,
      requestListener,
    );
    const snapshot = await entry.runtime.snapshot();
    this.scheduleUnload(params.threadId, entry);
    return { runtime: entry.runtime, snapshot };
  }

  async read(
    params: ParsedClientParams<'thread/read'>,
  ): Promise<ThreadSnapshot> {
    const records = await this.logs.read(params.threadId);
    const snapshot = projectThreadSnapshot(records);
    return filterSnapshot(snapshot, params.includeTurns, params.includeItems);
  }

  async list(params: ParsedClientParams<'thread/list'>): Promise<{
    readonly data: readonly ThreadSummary[];
    readonly nextCursor?: string;
  }> {
    const offset = parseCursor(params.cursor);
    const page = this.catalog.list({
      archived: params.archived,
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      offset,
      limit: params.limit,
    });
    const data = page.data;
    const nextOffset = offset + data.length;
    return {
      data,
      ...(page.hasMore ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async loaded(): Promise<readonly ThreadSummary[]> {
    return Promise.all(
      [...this.entries.values()].map(
        async (entry) => (await entry.runtime.snapshot()).thread,
      ),
    );
  }

  async fork(
    connectionId: string,
    params: ParsedClientParams<'thread/fork'>,
    listener?: SubscriptionListener,
    requestListener?: ServerRequestListener,
  ): Promise<ThreadAttachment> {
    this.assertRunning();
    assertListener(params.subscribe, listener);
    const source = await this.read({
      threadId: params.threadId,
      includeTurns: true,
      includeItems: true,
    });
    const sourceTurns = turnsThrough(source.turns, params.lastTurnId);
    if (sourceTurns.some((turn) => turn.status === 'inProgress')) {
      throw new AppServerError({
        type: 'threadBusy',
        message: 'Cannot fork an in-progress turn.',
      });
    }
    const threadId = createEntityId('thr');
    const sourceRecords = await this.logs.read(params.threadId);
    const lease = await this.leases.acquire(threadId);
    try {
      const created = await this.logs.create(threadId, {
        kind: 'thread.created',
        rootId: source.thread.rootId,
        forkedFromId: source.thread.id,
        cwd: source.thread.cwd,
        name: params.name ?? source.thread.name,
        settings: source.settings,
        metadata: {},
      });
      this.catalog.apply(created);
      const records = [created];
      for (const sourceTurn of sourceTurns) {
        const turn = cloneTurn(sourceTurn, threadId);
        records.push(
          await this.append(threadId, {
            kind: 'turn.started',
            turn: { ...turn, status: 'inProgress', items: [] },
          }),
        );
        for (const item of turn.items) {
          records.push(
            await this.append(threadId, {
              kind: 'item.started',
              turnId: turn.id,
              item,
            }),
          );
          records.push(
            await this.append(threadId, {
              kind: 'item.completed',
              turnId: turn.id,
              item,
            }),
          );
        }
        for (const transcript of sourceRecords.filter(
          (record) =>
            record.kind === 'transcript.entry' &&
            record.turnId === sourceTurn.id,
        )) {
          if (transcript.kind !== 'transcript.entry') continue;
          records.push(
            await this.append(threadId, {
              kind: 'transcript.entry',
              turnId: turn.id,
              role: transcript.role,
              message: transcript.message,
            }),
          );
        }
        const terminal = { ...turn, items: [] };
        records.push(
          await this.append(
            threadId,
            terminal.status === 'completed'
              ? { kind: 'turn.completed', turn: terminal }
              : terminal.status === 'interrupted'
                ? {
                    kind: 'turn.interrupted',
                    turn: terminal,
                    reason: 'forked history',
                  }
                : {
                    kind: 'turn.failed',
                    turn: terminal,
                    error: {
                      code: terminal.errorCode ?? 'SOURCE_TURN_FAILED',
                      message: 'Forked from a failed turn.',
                    },
                  },
          ),
        );
      }
      if (source.goal !== null) {
        records.push(
          await this.append(threadId, {
            kind: 'goal.state',
            goal: {
              ...source.goal,
              id: createEntityId('job'),
              status: 'paused',
              updatedAt: new Date().toISOString(),
            },
          }),
        );
      }
      const snapshot = projectThreadSnapshot(records);
      const executor = await this.executorFactory(snapshot);
      const runtime = new ThreadRuntime({
        records,
        logs: this.logs,
        catalog: this.catalog,
        executor,
        lease,
      });
      const entry: ThreadEntry = {
        runtime,
        subscriptions: new Map(),
        holds: 0,
        unloadTimer: undefined,
      };
      this.entries.set(threadId, entry);
      this.attach(
        entry,
        connectionId,
        params.subscribe,
        listener,
        requestListener,
      );
      const attachedSnapshot = await runtime.snapshot();
      this.scheduleUnload(threadId, entry);
      return { runtime, snapshot: attachedSnapshot };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  startTurn(
    threadId: string,
    input: readonly UserInput[],
    options?: Parameters<ThreadRuntime['startTurn']>[1],
  ): Promise<Turn> {
    return this.withEntry(threadId, false, (entry) =>
      entry.runtime.startTurn(input, options),
    );
  }

  steerTurn(
    threadId: string,
    turnId: string,
    input: readonly UserInput[],
  ): Promise<void> {
    return this.withEntry(threadId, false, (entry) =>
      entry.runtime.steerTurn(turnId, input),
    );
  }

  interruptTurn(
    threadId: string,
    turnId: string,
    reason?: string,
  ): Promise<Turn> {
    return this.withEntry(threadId, false, (entry) =>
      entry.runtime.interruptTurn(turnId, reason),
    );
  }

  async goal(threadId: string): Promise<Goal | null> {
    return (
      await this.read({
        threadId,
        includeTurns: false,
        includeItems: false,
      })
    ).goal;
  }

  async setGoal(
    threadId: string,
    input: Parameters<ThreadRuntime['setGoal']>[0],
  ): Promise<Goal> {
    return this.withEntry(threadId, true, (entry) =>
      entry.runtime.setGoal(input),
    );
  }

  async clearGoal(threadId: string): Promise<string> {
    return this.withEntry(threadId, true, (entry) => entry.runtime.clearGoal());
  }

  async plan(threadId: string): Promise<Plan | null> {
    return (
      await this.read({
        threadId,
        includeTurns: false,
        includeItems: false,
      })
    ).plan;
  }

  async setPlan(threadId: string, plan: Plan): Promise<Plan> {
    return this.withEntry(threadId, true, (entry) =>
      entry.runtime.setPlan(plan),
    );
  }

  async unsubscribe(connectionId: string, threadId: string): Promise<void> {
    const entry = this.entries.get(threadId);
    if (entry === undefined) return;
    entry.subscriptions.get(connectionId)?.();
    entry.subscriptions.delete(connectionId);
    this.scheduleUnload(threadId, entry);
  }

  async archive(threadId: string): Promise<ThreadSummary> {
    await this.unloadNow(threadId);
    await this.append(threadId, {
      kind: 'thread.metadata',
      archived: true,
    });
    await this.logs.archive(threadId);
    return projectThreadSnapshot(await this.logs.readArchived(threadId)).thread;
  }

  async unarchive(threadId: string): Promise<ThreadSummary> {
    await this.logs.unarchive(threadId);
    await this.append(threadId, {
      kind: 'thread.metadata',
      archived: false,
    });
    return projectThreadSnapshot(await this.logs.read(threadId)).thread;
  }

  async delete(threadId: string, archived: boolean): Promise<void> {
    await this.unloadNow(threadId);
    await this.logs.delete(threadId, archived);
    if (!this.catalog.delete(threadId)) {
      throw new Error(`Thread catalog ${threadId} disappeared before delete.`);
    }
  }

  async deleteAny(threadId: string): Promise<void> {
    if (await this.logs.exists(threadId, false)) {
      await this.delete(threadId, false);
      return;
    }
    if (await this.logs.exists(threadId, true)) {
      await this.delete(threadId, true);
      return;
    }
    throw new AppServerError({
      type: 'threadNotFound',
      message: `Thread ${threadId} does not exist.`,
    });
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const entries = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(
      entries.map(async ([, entry]) => {
        if (entry.unloadTimer !== undefined) clearTimeout(entry.unloadTimer);
        await entry.runtime.close();
      }),
    );
  }

  private async load(threadId: string): Promise<ThreadEntry> {
    const loaded = this.entries.get(threadId);
    if (loaded !== undefined) return loaded;
    const loading = this.loading.get(threadId);
    if (loading !== undefined) return loading;
    const task = this.loadOnce(threadId);
    this.loading.set(threadId, task);
    try {
      return await task;
    } finally {
      this.loading.delete(threadId);
    }
  }

  private async loadOnce(threadId: string): Promise<ThreadEntry> {
    const lease = await this.leases.acquire(threadId);
    try {
      const records = await this.logs.read(threadId);
      const snapshot = projectThreadSnapshot(records);
      const executor = await this.executorFactory(snapshot);
      const entry: ThreadEntry = {
        runtime: new ThreadRuntime({
          records,
          logs: this.logs,
          catalog: this.catalog,
          executor,
          lease,
        }),
        subscriptions: new Map(),
        holds: 0,
        unloadTimer: undefined,
      };
      this.entries.set(threadId, entry);
      this.scheduleUnload(threadId, entry);
      return entry;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  private attach(
    entry: ThreadEntry,
    connectionId: string,
    subscribe: boolean,
    listener: SubscriptionListener | undefined,
    requestListener: ServerRequestListener | undefined,
  ): void {
    if (!subscribe) return;
    if (listener === undefined) {
      throw new AppServerError({
        type: 'invalidParams',
        message: 'Subscribed thread requires a connection listener.',
      });
    }
    if (entry.unloadTimer !== undefined) {
      clearTimeout(entry.unloadTimer);
      entry.unloadTimer = undefined;
    }
    if (entry.subscriptions.has(connectionId)) return;
    entry.subscriptions.set(
      connectionId,
      entry.runtime.subscribe(connectionId, listener, requestListener),
    );
  }

  private scheduleUnload(threadId: string, entry: ThreadEntry): void {
    if (
      entry.subscriptions.size > 0 ||
      entry.holds > 0 ||
      entry.unloadTimer !== undefined
    ) {
      return;
    }
    entry.unloadTimer = setTimeout(() => {
      entry.unloadTimer = undefined;
      void this.unloadNow(threadId).catch(() => {
        const current = this.entries.get(threadId);
        if (!this.stopping && current === entry) {
          this.scheduleUnload(threadId, entry);
        }
      });
    }, this.unloadGraceMs);
  }

  private async unloadNow(threadId: string): Promise<void> {
    const entry = this.entries.get(threadId);
    if (entry === undefined) return;
    if (
      entry.holds > 0 ||
      entry.runtime.hasActiveTurn() ||
      entry.runtime.hasPendingServerRequest()
    ) {
      throw new AppServerError({
        type: 'threadBusy',
        message: `Thread ${threadId} cannot unload while work is active.`,
      });
    }
    this.entries.delete(threadId);
    if (entry.unloadTimer !== undefined) clearTimeout(entry.unloadTimer);
    await entry.runtime.close();
  }

  private requireLoaded(threadId: string): ThreadEntry {
    const entry = this.entries.get(threadId);
    if (entry === undefined) {
      throw new AppServerError({
        type: 'threadNotFound',
        message: `Thread ${threadId} is not loaded; call thread/resume first.`,
      });
    }
    return entry;
  }

  private async withEntry<T>(
    threadId: string,
    allowLoad: boolean,
    operation: (entry: ThreadEntry) => Promise<T>,
  ): Promise<T> {
    const entry = allowLoad
      ? await this.load(threadId)
      : this.requireLoaded(threadId);
    if (entry.unloadTimer !== undefined) {
      clearTimeout(entry.unloadTimer);
      entry.unloadTimer = undefined;
    }
    entry.holds += 1;
    try {
      return await operation(entry);
    } finally {
      entry.holds -= 1;
      this.scheduleUnload(threadId, entry);
    }
  }

  private assertRunning(): void {
    if (this.stopping) {
      throw new AppServerError({
        type: 'threadBusy',
        message: 'Thread manager is stopping.',
      });
    }
  }

  private async append(
    threadId: string,
    record: NewThreadRecord,
  ): Promise<ThreadRecord> {
    const persisted = await this.logs.append(threadId, record);
    this.catalog.apply(persisted);
    return persisted;
  }

  private async reconcileCatalog(): Promise<void> {
    const [activeIds, archivedIds] = await Promise.all([
      this.logs.listThreadIds(false),
      this.logs.listThreadIds(true),
    ]);
    const logIds = new Set<string>();
    for (const [archived, ids] of [
      [false, activeIds],
      [true, archivedIds],
    ] as const) {
      for (const threadId of ids) {
        if (logIds.has(threadId)) {
          throw new AppServerError({
            type: 'storageCorrupt',
            message: `Thread ${threadId} has both active and archived logs.`,
          });
        }
        logIds.add(threadId);
        const records = archived
          ? await this.logs.readArchived(threadId)
          : await this.logs.read(threadId);
        const snapshot = projectThreadSnapshot(records);
        const state = this.catalog.state(threadId);
        if (
          state === null ||
          state.seq !== snapshot.seq ||
          state.archived !== snapshot.thread.archived
        ) {
          this.catalog.rebuild(records);
        }
      }
    }
    for (const state of this.catalog.states()) {
      if (!logIds.has(state.id)) this.catalog.delete(state.id);
    }
  }
}

function filterSnapshot(
  snapshot: ThreadSnapshot,
  includeTurns: boolean,
  includeItems: boolean,
): ThreadSnapshot {
  if (!includeTurns) return { ...snapshot, turns: [] };
  if (includeItems) return snapshot;
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => ({ ...turn, items: [] })),
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppServerError({
      type: 'invalidParams',
      message: `Invalid pagination cursor ${cursor}.`,
    });
  }
  return value;
}

function turnsThrough(
  turns: readonly Turn[],
  lastTurnId: string | undefined,
): readonly Turn[] {
  if (lastTurnId === undefined) return turns;
  const index = turns.findIndex((turn) => turn.id === lastTurnId);
  if (index === -1) {
    throw new AppServerError({
      type: 'turnMismatch',
      message: `Fork turn ${lastTurnId} does not exist.`,
    });
  }
  return turns.slice(0, index + 1);
}

function cloneTurn(source: Turn, threadId: string): Turn {
  const turnId = createEntityId('turn');
  return {
    ...source,
    id: turnId,
    threadId,
    items: source.items.map((item) => ({
      ...item,
      id: createEntityId('item'),
      turnId,
    })),
  };
}

function assertListener(
  subscribe: boolean,
  listener: SubscriptionListener | undefined,
): void {
  if (subscribe && listener === undefined) {
    throw new AppServerError({
      type: 'invalidParams',
      message: 'Subscribed thread requires a connection listener.',
    });
  }
}
