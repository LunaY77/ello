import {
  type PendingServerRequest,
  type ThreadItem,
  type ThreadSnapshot,
  type Turn,
} from '../../protocol/v1/index.js';
import type { ThreadRecord } from '../../storage/threads/thread-record.js';

type MutableTurn = Omit<Turn, 'items'> & { items: ThreadItem[] };
type MutableThreadSnapshot = Omit<
  ThreadSnapshot,
  'turns' | 'pendingServerRequests'
> & {
  turns: MutableTurn[];
  pendingServerRequests: PendingServerRequest[];
};

const EMPTY_USAGE = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
} as const;

/** 从 append-only log 重建的可变工作状态，只在 projector 内部使用。 */
interface MutableProjection {
  snapshot: MutableThreadSnapshot | undefined;
  readonly turnIndexes: Map<string, number>;
  readonly itemIndexes: Map<string, { turnIndex: number; itemIndex: number }>;
}

export function projectThreadSnapshot(
  records: readonly ThreadRecord[],
): ThreadSnapshot {
  return new ThreadSnapshotProjector(records).current();
}

/** 同一 writer append 后立即增量投影，避免每条 delta 都重放完整日志。 */
export class ThreadSnapshotProjector {
  private readonly state: MutableProjection = {
    snapshot: undefined,
    turnIndexes: new Map(),
    itemIndexes: new Map(),
  };

  constructor(records: readonly ThreadRecord[] = []) {
    for (const record of records) this.apply(record);
  }

  apply(record: ThreadRecord): void {
    applyThreadRecord(this.state, record);
  }

  current(): ThreadSnapshot {
    if (this.state.snapshot === undefined) {
      throw new Error('Thread log does not contain thread.created.');
    }
    return structuredClone(this.state.snapshot) as ThreadSnapshot;
  }
}

function applyThreadRecord(
  state: MutableProjection,
  record: ThreadRecord,
): void {
  if (record.kind === 'thread.created') {
    if (state.snapshot !== undefined) {
      throw new Error('Thread log contains duplicate thread.created records.');
    }
    state.snapshot = {
      thread: {
        id: record.threadId,
        rootId: record.rootId,
        ...(record.forkedFromId === undefined
          ? {}
          : { forkedFromId: record.forkedFromId }),
        cwd: record.cwd,
        name: record.name,
        preview: '',
        status: 'idle',
        archived: false,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      },
      settings: record.settings,
      turns: [],
      pendingServerRequests: [],
      goal: null,
      plan: null,
      usage: EMPTY_USAGE,
      seq: record.seq,
    };
    return;
  }
  const snapshot = requireSnapshot(state);
  snapshot.seq = record.seq;
  snapshot.thread.updatedAt = record.createdAt;
  switch (record.kind) {
    case 'thread.metadata':
      if (record.name !== undefined) snapshot.thread.name = record.name;
      if (record.preview !== undefined)
        snapshot.thread.preview = record.preview;
      if (record.archived !== undefined) {
        snapshot.thread.archived = record.archived;
        snapshot.thread.status = record.archived ? 'archived' : 'idle';
      }
      if (record.settings !== undefined) snapshot.settings = record.settings;
      return;
    case 'thread.status':
      snapshot.thread.status = record.status;
      return;
    case 'turn.started':
      addTurn(state, record.turn);
      snapshot.thread.status = 'running';
      return;
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
      replaceTurn(state, record.turn);
      snapshot.thread.status =
        record.kind === 'turn.completed'
          ? 'idle'
          : record.kind === 'turn.interrupted'
            ? 'interrupted'
            : 'failed';
      return;
    case 'item.started':
      addItem(state, record.turnId, record.item);
      return;
    case 'item.delta':
      applyItemDelta(state, record.itemId, record.delta);
      return;
    case 'item.completed':
      replaceItem(state, record.turnId, record.item);
      return;
    case 'goal.state':
      snapshot.goal = record.goal;
      return;
    case 'plan.state':
      snapshot.plan = record.plan;
      return;
    case 'serverRequest.created':
      if (
        snapshot.pendingServerRequests.some(
          (request) => request.id === record.request.id,
        )
      ) {
        throw new Error(`Duplicate Server Request ${record.request.id}.`);
      }
      snapshot.pendingServerRequests.push(record.request);
      snapshot.thread.status =
        record.request.method === 'item/tool/requestUserInput'
          ? 'awaitingUserInput'
          : 'awaitingApproval';
      return;
    case 'serverRequest.resolved': {
      const index = snapshot.pendingServerRequests.findIndex(
        (request) => request.id === record.requestId,
      );
      if (index === -1) {
        throw new Error(`Resolved unknown Server Request ${record.requestId}.`);
      }
      snapshot.pendingServerRequests.splice(index, 1);
      if (snapshot.pendingServerRequests.length === 0) {
        snapshot.thread.status = activeTurn(snapshot) ? 'running' : 'idle';
      }
      return;
    }
    case 'usage.updated':
      snapshot.usage = record.usage;
      return;
    case 'transcript.entry':
    case 'compaction':
    case 'content.replacement':
      return;
  }
}

function requireSnapshot(state: MutableProjection): MutableThreadSnapshot {
  if (state.snapshot === undefined) {
    throw new Error('thread.created must be the first record.');
  }
  return state.snapshot;
}

function addTurn(state: MutableProjection, turn: Turn): void {
  const snapshot = requireSnapshot(state);
  if (state.turnIndexes.has(turn.id)) {
    throw new Error(`Duplicate turn ${turn.id}.`);
  }
  const turnIndex = snapshot.turns.length;
  snapshot.turns.push({ ...turn, items: [...turn.items] });
  state.turnIndexes.set(turn.id, turnIndex);
  turn.items.forEach((item, itemIndex) =>
    state.itemIndexes.set(item.id, { turnIndex, itemIndex }),
  );
}

function replaceTurn(state: MutableProjection, turn: Turn): void {
  const snapshot = requireSnapshot(state);
  const turnIndex = state.turnIndexes.get(turn.id);
  if (turnIndex === undefined) throw new Error(`Unknown turn ${turn.id}.`);
  const previous = snapshot.turns[turnIndex];
  if (previous === undefined) throw new Error(`Missing turn ${turn.id}.`);
  snapshot.turns[turnIndex] = { ...turn, items: previous.items };
}

function addItem(
  state: MutableProjection,
  turnId: string,
  item: ThreadItem,
): void {
  const snapshot = requireSnapshot(state);
  if (state.itemIndexes.has(item.id)) {
    throw new Error(`Duplicate item ${item.id}.`);
  }
  const turnIndex = state.turnIndexes.get(turnId);
  if (turnIndex === undefined) throw new Error(`Unknown turn ${turnId}.`);
  const turn = snapshot.turns[turnIndex];
  if (turn === undefined) throw new Error(`Missing turn ${turnId}.`);
  const itemIndex = turn.items.length;
  turn.items.push(item);
  state.itemIndexes.set(item.id, { turnIndex, itemIndex });
}

function replaceItem(
  state: MutableProjection,
  turnId: string,
  item: ThreadItem,
): void {
  const snapshot = requireSnapshot(state);
  const location = state.itemIndexes.get(item.id);
  if (location === undefined) throw new Error(`Unknown item ${item.id}.`);
  const turn = snapshot.turns[location.turnIndex];
  if (turn === undefined || turn.id !== turnId) {
    throw new Error(`Item ${item.id} does not belong to turn ${turnId}.`);
  }
  turn.items[location.itemIndex] = item;
}

function applyItemDelta(
  state: MutableProjection,
  itemId: string,
  delta: Extract<ThreadRecord, { kind: 'item.delta' }>['delta'],
): void {
  const snapshot = requireSnapshot(state);
  const location = state.itemIndexes.get(itemId);
  if (location === undefined) throw new Error(`Unknown item ${itemId}.`);
  const turn = snapshot.turns[location.turnIndex];
  const item = turn?.items[location.itemIndex];
  if (turn === undefined || item === undefined) {
    throw new Error(`Missing item ${itemId}.`);
  }
  turn.items[location.itemIndex] = projectThreadItemDelta(item, delta);
}

/** 内存 snapshot 与 SQLite catalog 共用同一条 item delta 投影规则。 */
export function projectThreadItemDelta(
  item: ThreadItem,
  delta: Extract<ThreadRecord, { kind: 'item.delta' }>['delta'],
): ThreadItem {
  const projected = structuredClone(item) as ThreadItem;
  if (delta.type === 'agentMessage' && projected.type === 'agentMessage') {
    projected.text += delta.text;
    return projected;
  }
  if (delta.type === 'plan' && projected.type === 'plan') {
    projected.text += delta.text;
    return projected;
  }
  if (delta.type === 'commandOutput' && projected.type === 'commandExecution') {
    projected.outputPreview = `${projected.outputPreview ?? ''}${delta.text}`;
    return projected;
  }
  throw new Error(`Delta ${delta.type} does not match item ${projected.type}.`);
}

function activeTurn(snapshot: MutableThreadSnapshot): boolean {
  return snapshot.turns.some((turn) => turn.status === 'inProgress');
}
