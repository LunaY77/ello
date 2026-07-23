/**
 * 本文件负责 thread feature 的record 投影。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import {
  AppServerError,
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

/**
 * 执行 Thread record 投影 模块 定义的 `projectThreadSnapshot` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `records`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `projectThreadSnapshot` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectThreadSnapshot(
  records: readonly ThreadRecord[],
): ThreadSnapshot {
  return createThreadSnapshotProjection(records).current();
}

export interface ThreadSnapshotProjection {
  /**
   * 在 Thread record 投影 模块 中执行 `apply` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `record`: 要由 `apply` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Thread record 投影 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  apply(record: ThreadRecord): void;
  /**
   * 读取 Thread record 投影 模块 的 `current` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `current` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  current(): ThreadSnapshot;
}

/**
 * 创建 append-only record 的增量 Thread snapshot 投影。
 *
 * Args:
 * - `records`: 已按连续 seq 排序并完成 schema 校验的初始记录；函数会立即按顺序重放。
 *
 * Returns:
 * - 返回共享一份私有可变状态的 `apply()` 与 `current()`；`current()` 每次返回独立快照。
 *
 * Throws:
 * - 当记录顺序、引用 id 或状态转换不合法时直接抛错。
 */
export function createThreadSnapshotProjection(
  records: readonly ThreadRecord[],
): ThreadSnapshotProjection {
  const state: MutableProjection = {
    snapshot: undefined,
    turnIndexes: new Map(),
    itemIndexes: new Map(),
  };
  const apply = (record: ThreadRecord): void => {
    applyThreadRecord(state, record);
  };
  for (const record of records) {
    apply(record);
  }
  return {
    apply,
    current() {
      if (state.snapshot === undefined) {
        throw new Error('Thread log does not contain thread.created.');
      }
      return structuredClone(state.snapshot);
    },
  };
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
  if (snapshot.thread.archived && record.kind !== 'thread.unarchived') {
    throw projectionCorrupt(
      record.threadId,
      `${record.kind} cannot follow thread.archived`,
    );
  }
  snapshot.seq = record.seq;
  snapshot.thread.updatedAt = record.createdAt;
  switch (record.kind) {
    case 'thread.metadata':
      if (record.name !== undefined) snapshot.thread.name = record.name;
      if (record.preview !== undefined)
        snapshot.thread.preview = record.preview;
      if (record.settings !== undefined) snapshot.settings = record.settings;
      return;
    case 'thread.archived':
      if (snapshot.thread.archived) {
        throw projectionCorrupt(record.threadId, 'Thread is already archived');
      }
      if (activeTurn(snapshot) || snapshot.pendingServerRequests.length > 0) {
        throw projectionCorrupt(
          record.threadId,
          'Thread was archived with active work',
        );
      }
      snapshot.thread.archived = true;
      return;
    case 'thread.unarchived':
      if (!snapshot.thread.archived) {
        throw projectionCorrupt(record.threadId, 'Thread is not archived');
      }
      snapshot.thread.archived = false;
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

function projectionCorrupt(threadId: string, reason: string): AppServerError {
  return new AppServerError({
    type: 'storageCorrupt',
    message: `Thread ${threadId} record sequence is invalid: ${reason}.`,
    details: { threadId, reason },
  });
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

/**
 * 内存 snapshot 与 SQLite catalog 共用同一条 item delta 投影规则。
 *
 * Args:
 * - `item`: 要由 `projectThreadItemDelta` 读取或写入的单个领域值；所有权仍归调用方。
 * - `delta`: `projectThreadItemDelta` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `projectThreadItemDelta` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectThreadItemDelta(
  item: ThreadItem,
  delta: Extract<ThreadRecord, { kind: 'item.delta' }>['delta'],
): ThreadItem {
  const projected = structuredClone(item);
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

/**
 * 把 Thread 边界接收的未知值转换成可持久化的 JSON 值。
 *
 * Args:
 * - `value`: 来自 Agent 消息或工具事件的未知值；调用方不保留其对象身份。
 *
 * Returns:
 * - 返回经过 JSON 序列化往返后的纯数据值，可安全交给协议 schema 或 record payload。
 *
 * Throws:
 * - 当值无法被 JSON 序列化时直接抛错。
 */
export function serializeJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Thread value is not JSON serializable.');
  }
  return JSON.parse(serialized);
}

function activeTurn(snapshot: MutableThreadSnapshot): boolean {
  return snapshot.turns.some((turn) => turn.status === 'inProgress');
}
