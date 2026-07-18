import { createEntityId } from '../../domain/ids.js';
import type {
  TurnExecutionEvent,
  TurnExecutionHandle,
  TurnExecutor,
} from '../../domain/ports/turn-executor.js';
import { ThreadSnapshotProjector } from '../../domain/projection/thread-snapshot.js';
import {
  AppServerError,
  type ServerNotification,
  type Goal,
  type Plan,
  type ThreadSnapshot,
  type Turn,
  type UserInput,
} from '../../protocol/v1/index.js';
import type { ThreadCatalogRepository } from '../../storage/repositories/thread-catalog-repository.js';
import type { ThreadLease } from '../../storage/threads/thread-lease.js';
import { ThreadLogRepository } from '../../storage/threads/thread-log.js';
import type {
  NewThreadRecord,
  ThreadRecord,
} from '../../storage/threads/thread-record.js';

import {
  SubscriptionHub,
  type ServerRequestListener,
  type SubscriptionListener,
} from './subscription-hub.js';

export interface ThreadRuntimeOptions {
  readonly records: readonly ThreadRecord[];
  readonly logs: ThreadLogRepository;
  readonly catalog: ThreadCatalogRepository;
  readonly executor: TurnExecutor;
  readonly lease: ThreadLease;
}

interface ActiveTurn {
  readonly id: string;
  readonly handle: TurnExecutionHandle;
  readonly driveTask: Promise<void>;
}

/** 固定 thread id 的进程内 runtime；切换 thread 必须创建另一个对象。 */
export class ThreadRuntime {
  readonly id: string;
  readonly rootId: string;
  readonly cwd: string;

  private readonly logs: ThreadLogRepository;
  private readonly catalog: ThreadCatalogRepository;
  private readonly executor: TurnExecutor;
  private readonly lease: ThreadLease;
  private readonly projector: ThreadSnapshotProjector;
  private readonly stopRecordListener: () => void;
  private readonly subscriptions = new SubscriptionHub();
  private mutationQueue: Promise<void> = Promise.resolve();
  private activeTurn: ActiveTurn | undefined;
  private closing = false;

  constructor(options: ThreadRuntimeOptions) {
    this.logs = options.logs;
    this.catalog = options.catalog;
    this.executor = options.executor;
    this.lease = options.lease;
    this.projector = new ThreadSnapshotProjector(options.records);
    const snapshot = this.projector.current();
    this.id = snapshot.thread.id;
    this.rootId = snapshot.thread.rootId;
    this.cwd = snapshot.thread.cwd;
    this.stopRecordListener = this.logs.subscribe(this.id, (record) =>
      this.applyPersistedRecord(record),
    );
  }

  get status(): ThreadSnapshot['thread']['status'] {
    return this.projector.current().thread.status;
  }

  snapshot(): Promise<ThreadSnapshot> {
    return Promise.resolve(this.projector.current());
  }

  subscribe(
    connectionId: string,
    listener: SubscriptionListener,
    requestListener?: ServerRequestListener,
  ): () => void {
    const unsubscribe = this.subscriptions.subscribe(
      connectionId,
      listener,
      requestListener,
    );
    if (requestListener !== undefined) {
      for (const request of this.projector.current().pendingServerRequests) {
        this.dispatchServerRequest(request);
      }
    }
    return unsubscribe;
  }

  hasSubscriber(connectionId: string): boolean {
    return this.subscriptions.has(connectionId);
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== undefined;
  }

  hasPendingServerRequest(): boolean {
    return this.projector.current().pendingServerRequests.length > 0;
  }

  startTurn(
    input: readonly UserInput[],
    options: {
      readonly model?: string;
      readonly profile?: string;
      readonly mode?: ThreadSnapshot['settings']['mode'];
    } = {},
  ): Promise<Turn> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (this.activeTurn !== undefined) {
        throw new AppServerError({
          type: 'threadBusy',
          message: `Thread ${this.id} already has an active turn.`,
        });
      }
      if (input.length === 0) {
        throw new AppServerError({
          type: 'invalidParams',
          message: 'turn/start requires at least one input.',
        });
      }
      if (
        options.model !== undefined ||
        options.profile !== undefined ||
        options.mode !== undefined
      ) {
        const snapshot = this.projector.current();
        await this.append({
          kind: 'thread.metadata',
          settings: {
            ...snapshot.settings,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.profile === undefined
              ? {}
              : { profile: options.profile }),
            ...(options.mode === undefined ? {} : { mode: options.mode }),
          },
        });
      }
      const turn: Turn = {
        id: createEntityId('turn'),
        threadId: this.id,
        status: 'inProgress',
        items: [],
        startedAt: new Date().toISOString(),
      };
      await this.append({ kind: 'turn.started', turn });
      await this.append({
        kind: 'thread.status',
        status: 'running',
        activeFlags: ['turn'],
      });
      for (const userInput of input) {
        const item = {
          type: 'userMessage' as const,
          id: createEntityId('item'),
          turnId: turn.id,
          createdAt: new Date().toISOString(),
          text: formatUserInput(userInput),
        };
        await this.append({ kind: 'item.started', turnId: turn.id, item });
        await this.append({ kind: 'item.completed', turnId: turn.id, item });
      }
      let handle: TurnExecutionHandle;
      try {
        handle = await this.executor.start({
          thread: this.projector.current(),
          turn,
          userInput: input,
        });
      } catch (error) {
        await this.finishTurn(turn, {
          status: 'failed',
          error: { code: 'EXECUTOR_START_FAILED', message: errorMessage(error) },
        });
        throw error;
      }
      const driveTask = this.driveTurn(turn, handle);
      this.activeTurn = { id: turn.id, handle, driveTask };
      void driveTask.catch(() => undefined);
      return turn;
    });
  }

  steerTurn(turnId: string, input: readonly UserInput[]): Promise<void> {
    return this.enqueue(async () => {
      const active = this.requireActiveTurn(turnId);
      await active.handle.steer(input);
    });
  }

  async interruptTurn(turnId: string, reason = 'client request'): Promise<Turn> {
    const activeToWait = await this.enqueue(async () => {
      const active = this.activeTurn;
      if (active === undefined) {
        const turn = this.findTurn(turnId);
        if (turn.status === 'inProgress') {
          throw new AppServerError({
            type: 'turnMismatch',
            message: `Turn ${turnId} is not active in this runtime.`,
          });
        }
        return undefined;
      }
      if (active.id !== turnId) {
        throw this.turnMismatch(turnId, active.id);
      }
      await active.handle.interrupt(reason);
      return active;
    });
    if (activeToWait !== undefined) await activeToWait.driveTask;
    return this.findTurn(turnId);
  }

  resolveServerRequest(requestId: string, result: unknown): Promise<void> {
    return this.enqueue(async () => {
      const { active, request } = this.requirePendingRequest(requestId);
      await active.handle.resolveServerRequest(requestId, result);
      await this.append({
        kind: 'serverRequest.resolved',
        requestId,
        turnId: request.turnId,
        itemId: request.itemId,
        resolution: 'resolved',
      });
    });
  }

  rejectServerRequest(
    requestId: string,
    error: { readonly code: number; readonly message: string },
  ): Promise<void> {
    return this.enqueue(async () => {
      const { active, request } = this.requirePendingRequest(requestId);
      await active.handle.rejectServerRequest(requestId, error);
      await this.append({
        kind: 'serverRequest.resolved',
        requestId,
        turnId: request.turnId,
        itemId: request.itemId,
        resolution: 'rejected',
      });
    });
  }

  updateSettings(
    settings: Partial<ThreadSnapshot['settings']>,
  ): Promise<ThreadSnapshot['settings']> {
    return this.enqueue(async () => {
      this.assertOpen();
      const next = { ...this.projector.current().settings, ...settings };
      await this.append({ kind: 'thread.metadata', settings: next });
      return next;
    });
  }

  setGoal(input: {
    readonly objective: string;
    readonly tokenBudget?: number;
    readonly status?: Goal['status'];
  }): Promise<Goal> {
    return this.enqueue(async () => {
      this.assertOpen();
      const current = this.projector.current().goal;
      const now = new Date().toISOString();
      const goal: Goal = {
        id: current?.id ?? createEntityId('job'),
        objective: input.objective,
        status: input.status ?? current?.status ?? 'active',
        ...(input.tokenBudget === undefined
          ? current?.tokenBudget === undefined
            ? {}
            : { tokenBudget: current.tokenBudget }
          : { tokenBudget: input.tokenBudget }),
        tokensUsed: current?.tokensUsed ?? 0,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await this.append({ kind: 'goal.state', goal });
      return goal;
    });
  }

  clearGoal(): Promise<string> {
    return this.enqueue(async () => {
      this.assertOpen();
      const current = this.projector.current().goal;
      if (current === null) {
        throw new AppServerError({
          type: 'invalidParams',
          message: `Thread ${this.id} has no goal.`,
        });
      }
      await this.append({ kind: 'goal.state', goal: null, goalId: current.id });
      return current.id;
    });
  }

  setPlan(plan: Plan): Promise<Plan> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (plan.threadId !== this.id) {
        throw new AppServerError({
          type: 'turnMismatch',
          message: `Plan belongs to ${plan.threadId}, expected ${this.id}.`,
        });
      }
      await this.append({ kind: 'plan.state', plan });
      return plan;
    });
  }

  compact(): Promise<string> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (this.activeTurn !== undefined) {
        throw new AppServerError({
          type: 'threadBusy',
          message: `Thread ${this.id} cannot compact during an active turn.`,
        });
      }
      const snapshot = this.projector.current();
      const jobId = createEntityId('job');
      await this.append({
        kind: 'compaction',
        turnId: snapshot.turns.at(-1)?.id ?? createEntityId('turn'),
        summary: `Manual compaction ${jobId}`,
        firstKeptSeq: Math.max(1, snapshot.seq),
        tokensBefore:
          snapshot.usage.inputTokens + snapshot.usage.outputTokens,
      });
      return jobId;
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const active = this.activeTurn;
    if (active !== undefined) {
      await active.handle.interrupt('thread runtime closing');
      await active.driveTask;
    }
    await this.mutationQueue;
    this.subscriptions.clear();
    try {
      await this.executor.close();
    } finally {
      this.stopRecordListener();
      await this.lease.release();
    }
  }

  private async driveTurn(
    turn: Turn,
    handle: TurnExecutionHandle,
  ): Promise<void> {
    let eventFailure: unknown;
    try {
      for await (const event of handle.events) {
        await this.enqueue(() => this.recordExecutionEvent(turn.id, event));
      }
    } catch (error) {
      eventFailure = error;
    }
    try {
      const result = await handle.final;
      await this.enqueue(async () => {
        if (eventFailure !== undefined && result.status === 'completed') {
          await this.finishTurn(turn, {
            status: 'failed',
            error: {
              code: 'EXECUTION_FAILED',
              message: errorMessage(eventFailure),
            },
          });
          return;
        }
        if (result.status === 'completed') {
          await this.finishTurn(turn, { status: 'completed', usage: result.usage });
        } else if (result.status === 'interrupted') {
          await this.finishTurn(turn, {
            status: 'interrupted',
            usage: result.usage,
            reason: result.reason,
          });
        } else {
          await this.finishTurn(turn, {
            status: 'failed',
            usage: result.usage,
            error: result.error,
          });
        }
      });
    } catch (error) {
      const failure = eventFailure ?? error;
      await this.enqueue(() =>
        this.finishTurn(turn, {
          status: 'failed',
          error: { code: 'EXECUTION_FAILED', message: errorMessage(failure) },
        }),
      );
    }
  }

  private async recordExecutionEvent(
    turnId: string,
    event: TurnExecutionEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'itemStarted':
        await this.append({ kind: 'item.started', turnId, item: event.item });
        return;
      case 'itemDelta':
        await this.append({
          kind: 'item.delta',
          turnId,
          itemId: event.itemId,
          delta: event.delta,
        });
        return;
      case 'itemCompleted':
        await this.append({ kind: 'item.completed', turnId, item: event.item });
        return;
      case 'planUpdated':
        await this.append({ kind: 'plan.state', plan: event.plan });
        return;
      case 'serverRequest':
        await this.append({
          kind: 'serverRequest.created',
          request: event.request,
        });
        return;
      case 'usage':
        await this.append({ kind: 'usage.updated', usage: event.usage });
        return;
    }
  }

  private async finishTurn(
    started: Turn,
    result:
      | { readonly status: 'completed'; readonly usage?: Turn['usage'] }
      | {
          readonly status: 'interrupted';
          readonly usage?: Turn['usage'];
          readonly reason: string;
        }
      | {
          readonly status: 'failed';
          readonly usage?: Turn['usage'];
          readonly error: { readonly code: string; readonly message: string };
        },
  ): Promise<void> {
    const turn: Turn = {
      ...started,
      status: result.status,
      items: [],
      completedAt: new Date().toISOString(),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.status === 'failed' ? { errorCode: result.error.code } : {}),
    };
    if (result.status === 'completed') {
      await this.append({ kind: 'turn.completed', turn });
    } else if (result.status === 'interrupted') {
      await this.append({
        kind: 'turn.interrupted',
        turn,
        reason: result.reason,
      });
    } else {
      await this.append({ kind: 'turn.failed', turn, error: result.error });
    }
    await this.append({
      kind: 'thread.status',
      status:
        result.status === 'completed'
          ? 'idle'
          : result.status === 'interrupted'
            ? 'interrupted'
            : 'failed',
      activeFlags: [],
    });
    if (result.usage !== undefined) {
      await this.append({ kind: 'usage.updated', usage: result.usage });
    }
    if (this.activeTurn?.id === started.id) this.activeTurn = undefined;
  }

  private append(record: NewThreadRecord): Promise<ThreadRecord> {
    return this.logs.append(this.id, record);
  }

  /** JSONL writer 已串行落盘后，runtime 才按同一 seq 更新两个可重建投影。 */
  private applyPersistedRecord(record: ThreadRecord): void {
    const expectedSeq = this.projector.current().seq + 1;
    if (record.threadId !== this.id || record.seq !== expectedSeq) {
      throw new AppServerError({
        type: 'storageCorrupt',
        message: `Thread ${this.id} received persisted seq ${record.seq}, expected ${expectedSeq}.`,
      });
    }
    this.catalog.apply(record);
    this.projector.apply(record);
    for (const notification of notificationsFor(
      record,
      this.projector.current(),
    )) {
      this.subscriptions.publish(notification);
    }
    if (record.kind === 'serverRequest.created') {
      this.dispatchServerRequest(record.request);
    }
  }

  private dispatchServerRequest(
    request: ThreadSnapshot['pendingServerRequests'][number],
  ): void {
    const response = this.subscriptions.request(request);
    if (response === undefined) return;
    void response
      .then((result) => this.resolveServerRequest(request.id, result))
      // 断线和没有 handler 都不能把持久化 pending request 伪装成已解决。
      .catch(() => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireActiveTurn(turnId: string): ActiveTurn {
    const active = this.activeTurn;
    if (active === undefined || active.id !== turnId) {
      throw this.turnMismatch(turnId, active?.id);
    }
    return active;
  }

  private requirePendingRequest(requestId: string): {
    readonly active: ActiveTurn;
    readonly request: ThreadSnapshot['pendingServerRequests'][number];
  } {
    const request = this.projector
      .current()
      .pendingServerRequests.find((candidate) => candidate.id === requestId);
    if (request === undefined) {
      throw new AppServerError({
        type: 'requestResolved',
        message: `Server Request ${requestId} is not pending.`,
      });
    }
    const active = this.activeTurn;
    if (active === undefined) {
      throw new AppServerError({
        type: 'turnMismatch',
        message: `Server Request ${requestId} has no active turn.`,
      });
    }
    return { active, request };
  }

  private findTurn(turnId: string): Turn {
    const turn = this.projector
      .current()
      .turns.find((candidate) => candidate.id === turnId);
    if (turn === undefined) {
      throw new AppServerError({
        type: 'turnMismatch',
        message: `Turn ${turnId} does not belong to thread ${this.id}.`,
      });
    }
    return turn;
  }

  private turnMismatch(expected: string, active: string | undefined) {
    return new AppServerError({
      type: 'turnMismatch',
      message: `Expected turn ${expected}, active turn is ${active ?? 'none'}.`,
      details: { expectedTurnId: expected, activeTurnId: active ?? null },
    });
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new AppServerError({
        type: 'threadBusy',
        message: `Thread ${this.id} is closing.`,
      });
    }
  }
}

function formatUserInput(input: UserInput): string {
  switch (input.type) {
    case 'text':
      return input.text;
    case 'file':
      return `@${input.path}`;
    case 'image':
      return `[image ${input.artifactId}]`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notificationsFor(
  record: ThreadRecord,
  snapshot: ThreadSnapshot,
): readonly ServerNotification[] {
  switch (record.kind) {
    case 'thread.created':
      return [
        {
          method: 'thread/started',
          params: { threadId: record.threadId, seq: record.seq, thread: snapshot.thread },
        },
      ];
    case 'thread.status':
      return [
        {
          method: 'thread/status/changed',
          params: {
            threadId: record.threadId,
            seq: record.seq,
            status: record.status,
            activeFlags: record.activeFlags,
          },
        },
      ];
    case 'thread.metadata':
      if (record.settings !== undefined) {
        return [
          {
            method: 'thread/settings/updated',
            params: {
              threadId: record.threadId,
              seq: record.seq,
              settings: record.settings,
            },
          },
        ];
      }
      if (record.name !== undefined) {
        return [
          {
            method: 'thread/name/updated',
            params: {
              threadId: record.threadId,
              seq: record.seq,
              name: record.name,
            },
          },
        ];
      }
      return [sequenceAdvanced(record)];
    case 'turn.started':
      return [
        {
          method: 'turn/started',
          params: {
            threadId: record.threadId,
            turnId: record.turn.id,
            seq: record.seq,
            turn: record.turn,
          },
        },
      ];
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
      return [
        {
          method: 'turn/completed',
          params: {
            threadId: record.threadId,
            turnId: record.turn.id,
            seq: record.seq,
            turn: snapshot.turns.find((turn) => turn.id === record.turn.id) ?? record.turn,
          },
        },
      ];
    case 'item.started':
      return [
        {
          method: 'item/started',
          params: {
            threadId: record.threadId,
            turnId: record.turnId,
            itemId: record.item.id,
            seq: record.seq,
            item: record.item,
          },
        },
      ];
    case 'item.completed':
      return [
        {
          method: 'item/completed',
          params: {
            threadId: record.threadId,
            turnId: record.turnId,
            itemId: record.item.id,
            seq: record.seq,
            item: record.item,
          },
        },
      ];
    case 'item.delta': {
      const base = {
        threadId: record.threadId,
        turnId: record.turnId,
        itemId: record.itemId,
        seq: record.seq,
      };
      if (record.delta.type === 'agentMessage') {
        return [
          {
            method: 'item/agentMessage/delta',
            params: { ...base, delta: record.delta.text },
          },
        ];
      }
      if (record.delta.type === 'plan') {
        return [
          {
            method: 'item/plan/delta',
            params: { ...base, delta: record.delta.text },
          },
        ];
      }
      return [
        {
          method: 'item/commandExecution/outputDelta',
          params: {
            ...base,
            stream: record.delta.stream,
            delta: record.delta.text,
          },
        },
      ];
    }
    case 'goal.state':
      return record.goal === null
        ? [
            {
              method: 'thread/goal/cleared',
              params: {
                threadId: record.threadId,
                seq: record.seq,
                goalId: record.goalId ?? `${record.threadId}:goal`,
              },
            },
          ]
        : [
            {
              method: 'thread/goal/updated',
              params: {
                threadId: record.threadId,
                seq: record.seq,
                goal: record.goal,
              },
            },
          ];
    case 'serverRequest.resolved': {
      return [
        {
          method: 'serverRequest/resolved',
          params: {
            threadId: record.threadId,
            turnId: record.turnId,
            itemId: record.itemId,
            requestId: record.requestId,
            seq: record.seq,
          },
        },
      ];
    }
    case 'usage.updated':
      return [
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: record.threadId,
            seq: record.seq,
            usage: record.usage,
          },
        },
      ];
    case 'plan.state':
      return [
        {
          method: 'thread/plan/updated',
          params: {
            threadId: record.threadId,
            seq: record.seq,
            plan: record.plan,
          },
        },
      ];
    case 'compaction':
      return [
        {
          method: 'thread/compaction/updated',
          params: {
            threadId: record.threadId,
            turnId: record.turnId,
            seq: record.seq,
            summary: record.summary,
            firstKeptSeq: record.firstKeptSeq,
            tokensBefore: record.tokensBefore,
          },
        },
      ];
    case 'transcript.entry':
    case 'content.replacement':
    case 'serverRequest.created':
      // 这些记录属于 Server 内部事实，不向 Client 暴露内容；仍必须推进公开 seq，
      // 否则下一条可见事件会被严格 reducer 误判为 transport 丢包。
      return [sequenceAdvanced(record)];
  }
}

function sequenceAdvanced(record: ThreadRecord): ServerNotification {
  return {
    method: 'thread/sequence/advanced',
    params: { threadId: record.threadId, seq: record.seq },
  };
}
