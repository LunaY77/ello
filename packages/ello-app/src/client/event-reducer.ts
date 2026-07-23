/**
 * 单一事件归并器:所有入站事件先经这里,在一次 Zustand update 中原子更新
 * 受影响的 slices。事件语义对齐 Server 的 response barrier 契约:
 *
 * - seq <= 当前:barrier 滞留的重复事件,跳过(快照已包含其效果)。
 * - seq == 当前 + 1:正常推进,严格应用(缺引用即协议违约,抛错)。
 * - seq 断层:直接抛 ProtocolViolationError,由 session 关闭连接。
 * - 未加载快照的 thread 事件:未被订阅,不会出现;出现即视为协议违约。
 */
import {
  parseServerRequestParams,
  SERVER_REQUEST_SCHEMAS,
  type ServerNotification,
  type ServerRequestMethod,
  type ThreadItem,
  type ThreadSnapshot,
  type ThreadSummary,
  type Turn,
} from '@ello/agent/protocol';

import type {
  AppState,
  CatalogEntry,
  CatalogKind,
  EntitiesState,
  PendingRequestEntry,
  Repository,
  Task,
  Workspace,
} from '@/store/types';

export class ProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolViolationError';
  }
}

export type StoreEvent =
  | { readonly kind: 'snapshot-loaded'; readonly snapshot: ThreadSnapshot }
  | {
      readonly kind: 'threads-listed';
      readonly threads: readonly ThreadSummary[];
      readonly reset: boolean;
    }
  | { readonly kind: 'thread-upserted'; readonly thread: ThreadSummary }
  | { readonly kind: 'thread-removed'; readonly threadId: string }
  | {
      readonly kind: 'workspaces-listed';
      readonly workspaces: readonly Workspace[];
    }
  | { readonly kind: 'repos-listed'; readonly repos: readonly Repository[] }
  | {
      readonly kind: 'tasks-listed';
      readonly tasks: readonly Task[];
      readonly reset: boolean;
    }
  | { readonly kind: 'task-upserted'; readonly task: Task }
  | { readonly kind: 'task-deleted'; readonly taskId: string }
  | {
      readonly kind: 'catalog-loaded';
      readonly catalog: CatalogKind;
      readonly entries: readonly CatalogEntry[];
    }
  | { readonly kind: 'server-request-received'; readonly entry: PendingRequestEntry }
  | {
      readonly kind: 'server-request-state';
      readonly requestId: string;
      readonly state: PendingRequestEntry['state'];
    }
  | {
      readonly kind: 'notification';
      readonly notification: ServerNotification;
      readonly receivedAt: number;
    };

const MAX_WARNINGS = 50;

/** 应用一个事件并返回新 state;输入 state 不被修改。 */
export function applyStoreEvent(state: AppState, event: StoreEvent): AppState {
  switch (event.kind) {
    case 'snapshot-loaded':
      return withSnapshot(state, event.snapshot);
    case 'threads-listed': {
      const threads: Record<string, ThreadSummary> = event.reset
        ? {}
        : { ...state.entities.threads };
      for (const thread of event.threads) {
        threads[thread.id] = thread;
      }
      return withEntities(state, { threads });
    }
    case 'thread-upserted':
      return withEntities(state, {
        threads: { ...state.entities.threads, [event.thread.id]: event.thread },
      });
    case 'thread-removed': {
      const threads = { ...state.entities.threads };
      delete threads[event.threadId];
      const snapshots = { ...state.entities.snapshots };
      delete snapshots[event.threadId];
      const next = withEntities(state, { threads, snapshots });
      return {
        ...next,
        interaction: {
          pendingRequests: next.interaction.pendingRequests.filter(
            (entry) => entry.threadId !== event.threadId,
          ),
        },
      };
    }
    case 'repos-listed':
      return withEntities(state, { repos: event.repos });
    case 'workspaces-listed': {
      const workspaces: Record<string, Workspace> = {};
      for (const workspace of event.workspaces) {
        workspaces[workspace.id] = workspace;
      }
      return withEntities(state, { workspaces });
    }
    case 'tasks-listed': {
      const tasks: Record<string, Task> = event.reset ? {} : { ...state.entities.tasks };
      for (const task of event.tasks) {
        tasks[task.id] = task;
      }
      return withEntities(state, { tasks });
    }
    case 'task-upserted':
      return withEntities(state, {
        tasks: { ...state.entities.tasks, [event.task.id]: event.task },
      });
    case 'task-deleted': {
      const tasks = { ...state.entities.tasks };
      delete tasks[event.taskId];
      return withEntities(state, { tasks });
    }
    case 'catalog-loaded':
      return withEntities(state, {
        catalogs: { ...state.entities.catalogs, [event.catalog]: event.entries },
      });
    case 'server-request-received': {
      if (state.interaction.pendingRequests.some((r) => r.id === event.entry.id)) {
        throw new ProtocolViolationError(
          `Duplicate server request ${event.entry.id}.`,
        );
      }
      return {
        ...state,
        interaction: {
          pendingRequests: [...state.interaction.pendingRequests, event.entry],
        },
      };
    }
    case 'server-request-state': {
      if (!state.interaction.pendingRequests.some((entry) => entry.id === event.requestId)) {
        throw new ProtocolViolationError(
          `Server request state targets unknown request ${event.requestId}.`,
        );
      }
      return {
        ...state,
        interaction: {
          pendingRequests: state.interaction.pendingRequests.map((entry) =>
            entry.id === event.requestId
              ? { ...entry, state: event.state }
              : entry,
          ),
        },
      };
    }
    case 'notification':
      return applyNotification(state, event.notification, event.receivedAt);
  }
}

function applyNotification(
  state: AppState,
  notification: ServerNotification,
  receivedAt: number,
): AppState {
  switch (notification.method) {
    case 'server/ready':
    case 'fs/changed':
    case 'memory/job/updated':
      // 这些事件不对应全局实体投影,由各 feature 在需要时直接消费。
      return state;
    case 'warning': {
      const warnings = [
        ...state.entities.warnings,
        {
          code: notification.params.code,
          message: notification.params.message,
          at: receivedAt,
        },
      ].slice(-MAX_WARNINGS);
      return withEntities(state, { warnings });
    }
    case 'skills/changed':
      return withEntities(state, {
        skillsRevision: state.entities.skillsRevision + 1,
      });
    default:
      return applyThreadNotification(state, notification);
  }
}

type ThreadNotification = Exclude<
  ServerNotification,
  | { readonly method: 'server/ready' }
  | { readonly method: 'warning' }
  | { readonly method: 'skills/changed' }
  | { readonly method: 'fs/changed' }
  | { readonly method: 'memory/job/updated' }
>;

interface SeqGate {
  /** false = 重复事件,整条跳过。 */
  readonly apply: boolean;
  readonly snapshot: ThreadSnapshot;
}

function seqGate(entities: EntitiesState, threadId: string, seq: number): SeqGate {
  const snapshot = entities.snapshots[threadId];
  if (snapshot === undefined) {
    throw new ProtocolViolationError(
      `Event targets unloaded thread snapshot ${threadId}.`,
    );
  }
  if (seq <= snapshot.seq) {
    return { apply: false, snapshot };
  }
  if (seq > snapshot.seq + 1) {
    throw new ProtocolViolationError(
      `Event sequence gap for thread ${threadId}: expected ${snapshot.seq + 1}, received ${seq}.`,
    );
  }
  return { apply: true, snapshot };
}

function applyThreadNotification(
  state: AppState,
  notification: ThreadNotification,
): AppState {
  const { threadId, seq } = notification.params;
  const gate = seqGate(state.entities, threadId, seq);
  if (!gate.apply) return state;

  const base = state;

  switch (notification.method) {
    case 'thread/sequence/advanced':
      return updateSnapshotIfPresent(base, gate.snapshot, threadId, { seq });

    case 'thread/started': {
      let next = withEntities(base, {
        threads: {
          ...base.entities.threads,
          [notification.params.thread.id]: notification.params.thread,
        },
      });
      if (gate.snapshot !== undefined) {
        next = updateSnapshot(next, threadId, {
          seq,
          thread: notification.params.thread,
        });
      }
      return next;
    }

    case 'thread/status/changed': {
      const status = notification.params.status;
      let next = updateSummaryIfPresent(base, threadId, (summary) => ({
        ...summary,
        status,
      }));
      next = withEntities(next, {
        activeFlags: {
          ...next.entities.activeFlags,
          [threadId]: notification.params.activeFlags,
        },
      });
      if (gate.snapshot !== undefined) {
        next = updateSnapshot(next, threadId, {
          seq,
          thread: { ...gate.snapshot.thread, status },
        });
      }
      return next;
    }

    case 'thread/closed': {
      const snapshots = { ...base.entities.snapshots };
      delete snapshots[threadId];
      const activeFlags = { ...base.entities.activeFlags };
      delete activeFlags[threadId];
      const compactions = { ...base.entities.compactions };
      delete compactions[threadId];
      const next = withEntities(base, { snapshots, activeFlags, compactions });
      return {
        ...next,
        interaction: {
          pendingRequests: next.interaction.pendingRequests.filter(
            (entry) => entry.threadId !== threadId,
          ),
        },
      };
    }

    case 'thread/name/updated': {
      let next = updateSummaryIfPresent(base, threadId, (summary) => ({
        ...summary,
        name: notification.params.name,
      }));
      if (gate.snapshot !== undefined) {
        next = updateSnapshot(next, threadId, {
          seq,
          thread: { ...gate.snapshot.thread, name: notification.params.name },
        });
      }
      return next;
    }

    case 'thread/settings/updated':
      return updateSnapshotIfPresent(base, gate.snapshot, threadId, {
        seq,
        settings: notification.params.settings,
      });

    case 'thread/goal/updated':
      return updateSnapshotIfPresent(base, gate.snapshot, threadId, {
        seq,
        goal: notification.params.goal,
      });

    case 'thread/goal/cleared':
      return updateSnapshotIfPresent(base, gate.snapshot, threadId, {
        seq,
        goal: null,
      });

    case 'thread/tokenUsage/updated':
      return updateSnapshotIfPresent(base, gate.snapshot, threadId, {
        seq,
        usage: notification.params.usage,
      });

    case 'thread/plan/updated':
      return updateSnapshotIfPresent(base, gate.snapshot, threadId, {
        seq,
        plan: notification.params.plan,
      });

    case 'thread/compaction/updated': {
      const next = updateSnapshotIfPresent(base, gate.snapshot, threadId, { seq });
      return withEntities(next, {
        compactions: {
          ...next.entities.compactions,
          [threadId]: {
            summary: notification.params.summary,
            tokensBefore: notification.params.tokensBefore,
            atSeq: seq,
          },
        },
      });
    }

    case 'thread/archived': {
      let next = updateSummaryIfPresent(base, threadId, (summary) => ({
        ...summary,
        archived: true,
      }));
      if (gate.snapshot !== undefined) {
        next = updateSnapshot(next, threadId, {
          seq,
          thread: { ...gate.snapshot.thread, archived: true },
        });
      }
      return next;
    }

    case 'thread/unarchived': {
      let next = withEntities(base, {
        threads: {
          ...base.entities.threads,
          [threadId]: notification.params.thread,
        },
      });
      if (gate.snapshot !== undefined) {
        next = updateSnapshot(next, threadId, {
          seq,
          thread: notification.params.thread,
        });
      }
      return next;
    }

    case 'thread/deleted': {
      const threads = { ...base.entities.threads };
      delete threads[threadId];
      const snapshots = { ...base.entities.snapshots };
      delete snapshots[threadId];
      const next = withEntities(base, { threads, snapshots });
      return {
        ...next,
        interaction: {
          pendingRequests: next.interaction.pendingRequests.filter(
            (entry) => entry.threadId !== threadId,
          ),
        },
      };
    }

    case 'turn/started':
      return mutateTurns(base, gate.snapshot, threadId, seq, (turns) =>
        upsertTurn(turns, notification.params.turn),
      );

    case 'turn/completed':
      return mutateTurns(base, gate.snapshot, threadId, seq, (turns) =>
        turns.map((turn) =>
          turn.id === notification.params.turn.id
            ? notification.params.turn
            : turn,
        ),
      );

    case 'turn/diff/updated': {
      const next = withEntities(base, {
        turnDiffs: {
          ...base.entities.turnDiffs,
          [notification.params.turnId]: notification.params.changes,
        },
      });
      return updateSnapshotIfPresent(next, gate.snapshot, threadId, { seq });
    }

    case 'item/started':
      return mutateItems(
        base,
        gate.snapshot,
        threadId,
        notification.params.turnId,
        seq,
        (items) => upsertItem(items, notification.params.item),
      );

    case 'item/completed':
      return mutateItems(
        base,
        gate.snapshot,
        threadId,
        notification.params.turnId,
        seq,
        (items) =>
          items.map((item) =>
            item.id === notification.params.itemId
              ? notification.params.item
              : item,
          ),
      );

    case 'item/agentMessage/delta':
      return appendItemText(
        base,
        gate.snapshot,
        threadId,
        notification.params.turnId,
        notification.params.itemId,
        seq,
        'agentMessage',
        notification.params.delta,
      );

    case 'item/plan/delta':
      return appendItemText(
        base,
        gate.snapshot,
        threadId,
        notification.params.turnId,
        notification.params.itemId,
        seq,
        'plan',
        notification.params.delta,
      );

    case 'item/commandExecution/outputDelta':
      return mutateItems(
        base,
        gate.snapshot,
        threadId,
        notification.params.turnId,
        seq,
        (items) =>
          items.map((item) => {
            if (item.id !== notification.params.itemId) return item;
            if (item.type !== 'commandExecution') {
              throw new ProtocolViolationError(
                `outputDelta targets non-command item ${item.id}.`,
              );
            }
            return {
              ...item,
              outputPreview: (item.outputPreview ?? '') + notification.params.delta,
            };
          }),
      );

    case 'serverRequest/resolved': {
      const next = updateSnapshotIfPresent(base, gate.snapshot, threadId, { seq });
      return {
        ...next,
        interaction: {
          pendingRequests: next.interaction.pendingRequests.filter(
            (entry) => entry.id !== notification.params.requestId,
          ),
        },
      };
    }
  }
}

function upsertTurn(turns: readonly Turn[], turn: Turn): readonly Turn[] {
  const index = turns.findIndex((current) => current.id === turn.id);
  if (index === -1) return [...turns, turn];
  const next = [...turns];
  next[index] = turn;
  return next;
}

function upsertItem(
  items: readonly ThreadItem[],
  item: ThreadItem,
): readonly ThreadItem[] {
  const index = items.findIndex((current) => current.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function withEntities(
  state: AppState,
  patch: Partial<EntitiesState>,
): AppState {
  return { ...state, entities: { ...state.entities, ...patch } };
}

function updateSummaryIfPresent(
  state: AppState,
  threadId: string,
  update: (summary: ThreadSummary) => ThreadSummary,
): AppState {
  const summary = state.entities.threads[threadId];
  if (summary === undefined) return state;
  return withEntities(state, {
    threads: { ...state.entities.threads, [threadId]: update(summary) },
  });
}

function updateSnapshotIfPresent(
  state: AppState,
  snapshot: ThreadSnapshot,
  threadId: string,
  patch: Partial<ThreadSnapshot>,
): AppState {
  return updateSnapshot(state, threadId, patch);
}

function updateSnapshot(
  state: AppState,
  threadId: string,
  patch: Partial<ThreadSnapshot>,
): AppState {
  const snapshot = state.entities.snapshots[threadId];
  if (snapshot === undefined) {
    throw new ProtocolViolationError(
      `Event targets unloaded thread snapshot ${threadId}.`,
    );
  }
  return withEntities(state, {
    snapshots: {
      ...state.entities.snapshots,
      [threadId]: { ...snapshot, ...patch },
    },
  });
}

function mutateTurns(
  state: AppState,
  snapshot: ThreadSnapshot,
  threadId: string,
  seq: number,
  mutate: (turns: readonly Turn[]) => readonly Turn[],
): AppState {
  return withEntities(state, {
    snapshots: {
      ...state.entities.snapshots,
      [threadId]: { ...snapshot, seq, turns: mutate(snapshot.turns) },
    },
  });
}

function mutateItems(
  state: AppState,
  snapshot: ThreadSnapshot,
  threadId: string,
  turnId: string,
  seq: number,
  mutate: (items: readonly ThreadItem[]) => readonly ThreadItem[],
): AppState {
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) {
    throw new ProtocolViolationError(
      `Item event references unknown turn ${turnId} in thread ${threadId}.`,
    );
  }
  return mutateTurns(state, snapshot, threadId, seq, (turns) =>
    turns.map((candidate) =>
      candidate.id === turnId ? { ...candidate, items: mutate(candidate.items) } : candidate,
    ),
  );
}

function appendItemText(
  state: AppState,
  snapshot: ThreadSnapshot,
  threadId: string,
  turnId: string,
  itemId: string,
  seq: number,
  type: 'agentMessage' | 'plan',
  delta: string,
): AppState {
  return mutateItems(
    state,
    snapshot,
    threadId,
    turnId,
    seq,
    (items) => {
      const item = items.find((candidate) => candidate.id === itemId);
      if (item === undefined) {
        throw new ProtocolViolationError(
          `Text delta references unknown item ${itemId}.`,
        );
      }
      if (item.type !== type) {
        throw new ProtocolViolationError(
          `Text delta targets ${item.type} item ${itemId}.`,
        );
      }
      const updated = { ...item, text: item.text + delta };
      return items.map((candidate) =>
        candidate.id === itemId ? updated : candidate,
      );
    },
  );
}

/** 完整快照是重连/打开会话后的事实重置点:替换快照并重建该 thread 的待审批队列。 */
function withSnapshot(state: AppState, snapshot: ThreadSnapshot): AppState {
  const seeded: PendingRequestEntry[] = snapshot.pendingServerRequests.map(
    (request) => {
      if (!(request.method in SERVER_REQUEST_SCHEMAS)) {
        throw new ProtocolViolationError(
          `Snapshot carries unknown server request method ${request.method}.`,
        );
      }
      return {
        id: request.id,
        method: request.method as ServerRequestMethod,
        threadId: request.threadId,
        turnId: request.turnId,
        itemId: request.itemId,
        params: parseServerRequestParams(
          request.method as ServerRequestMethod,
          request.params,
        ),
        createdAt: request.createdAt,
        state: 'pending' as const,
      };
    },
  );
  const pendingRequests = [
    ...state.interaction.pendingRequests.filter(
      (entry) => entry.threadId !== snapshot.thread.id,
    ),
    ...seeded,
  ];
  return {
    ...state,
    entities: {
      ...state.entities,
      threads: {
        ...state.entities.threads,
        [snapshot.thread.id]: snapshot.thread,
      },
      snapshots: {
        ...state.entities.snapshots,
        [snapshot.thread.id]: snapshot,
      },
    },
    interaction: { pendingRequests },
  };
}
