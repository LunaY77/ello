import type {
  ServerNotification,
  ThreadItem,
  ThreadSnapshot,
  Turn,
} from '../api/protocol-types.js';

export interface ClientProjection {
  readonly snapshot: ThreadSnapshot;
  readonly stale: boolean;
}

export interface NotificationReduction {
  readonly projection: ClientProjection;
  readonly duplicate: boolean;
  readonly gap:
    | { readonly expectedSeq: number; readonly receivedSeq: number }
    | undefined;
}

type SequencedNotification = Extract<
  ServerNotification,
  { readonly params: { readonly threadId: string; readonly seq: number } }
>;

export function reduceNotification(
  projection: ClientProjection,
  notification: ServerNotification,
): NotificationReduction {
  if (!isSequencedNotification(notification))
    return { projection, duplicate: true, gap: undefined };
  const threadId = notification.params.threadId;
  if (threadId !== projection.snapshot.thread.id) {
    return { projection, duplicate: true, gap: undefined };
  }
  const seq = notification.params.seq;
  const currentSeq = projection.snapshot.seq;
  if (seq <= currentSeq) {
    return { projection, duplicate: true, gap: undefined };
  }
  const gap =
    seq === currentSeq + 1
      ? undefined
      : { expectedSeq: currentSeq + 1, receivedSeq: seq };
  const snapshot = applyNotification(projection.snapshot, notification);
  return {
    projection: {
      snapshot: { ...snapshot, seq: Math.max(snapshot.seq, seq) },
      stale: projection.stale || gap !== undefined,
    },
    duplicate: false,
    gap,
  };
}

export function applyNotification(
  snapshot: ThreadSnapshot,
  notification: ServerNotification,
): ThreadSnapshot {
  switch (notification.method) {
    case 'thread/sequence/advanced':
      return snapshot;
    case 'thread/status/changed':
      return {
        ...snapshot,
        thread: { ...snapshot.thread, status: notification.params.status },
      };
    case 'thread/name/updated':
      return {
        ...snapshot,
        thread: { ...snapshot.thread, name: notification.params.name },
      };
    case 'thread/settings/updated':
      return { ...snapshot, settings: notification.params.settings };
    case 'thread/plan/updated':
      return { ...snapshot, plan: notification.params.plan };
    case 'thread/goal/updated':
      return { ...snapshot, goal: notification.params.goal };
    case 'thread/goal/cleared':
      return { ...snapshot, goal: null };
    case 'thread/tokenUsage/updated':
      return { ...snapshot, usage: notification.params.usage };
    case 'thread/archived':
      return {
        ...snapshot,
        thread: { ...snapshot.thread, archived: true, status: 'archived' },
      };
    case 'thread/unarchived':
      return { ...snapshot, thread: notification.params.thread };
    case 'turn/started':
      return replaceTurn(snapshot, notification.params.turn, true);
    case 'turn/completed':
      return replaceTurn(snapshot, notification.params.turn, false);
    case 'item/started':
      return replaceItem(
        snapshot,
        notification.params.turnId,
        notification.params.itemId,
        notification.params.item,
        true,
      );
    case 'item/completed':
      return replaceItem(
        snapshot,
        notification.params.turnId,
        notification.params.itemId,
        notification.params.item,
        false,
      );
    case 'item/agentMessage/delta':
    case 'item/plan/delta':
      return appendItemText(
        snapshot,
        notification.params.turnId,
        notification.params.itemId,
        notification.params.delta,
      );
    case 'item/commandExecution/outputDelta':
      return appendCommandOutput(
        snapshot,
        notification.params.turnId,
        notification.params.itemId,
        notification.params.delta,
      );
    default:
      return snapshot;
  }
}

function replaceTurn(
  snapshot: ThreadSnapshot,
  turn: Turn,
  appendIfMissing: boolean,
): ThreadSnapshot {
  const index = snapshot.turns.findIndex((current) => current.id === turn.id);
  if (index === -1) {
    return appendIfMissing
      ? { ...snapshot, turns: [...snapshot.turns, turn] }
      : snapshot;
  }
  const turns = [...snapshot.turns];
  turns[index] = turn;
  return { ...snapshot, turns };
}

function replaceItem(
  snapshot: ThreadSnapshot,
  turnId: string,
  itemId: string,
  item: ThreadItem,
  appendIfMissing: boolean,
): ThreadSnapshot {
  const turnIndex = snapshot.turns.findIndex((turn) => turn.id === turnId);
  if (turnIndex === -1) return snapshot;
  const turn = snapshot.turns[turnIndex];
  if (turn === undefined) return snapshot;
  const itemIndex = turn.items.findIndex((current) => current.id === itemId);
  if (itemIndex === -1) {
    if (!appendIfMissing) return snapshot;
    return replaceTurn(
      snapshot,
      { ...turn, items: [...turn.items, item] },
      false,
    );
  }
  const items = [...turn.items];
  items[itemIndex] = item;
  return replaceTurn(snapshot, { ...turn, items }, false);
}

function isSequencedNotification(
  notification: ServerNotification,
): notification is SequencedNotification {
  return 'threadId' in notification.params && 'seq' in notification.params;
}

function appendItemText(
  snapshot: ThreadSnapshot,
  turnId: string,
  itemId: string,
  delta: string,
): ThreadSnapshot {
  const turn = snapshot.turns.find((current) => current.id === turnId);
  const item = turn?.items.find((current) => current.id === itemId);
  if (item === undefined) return snapshot;
  if (item.type === 'agentMessage') {
    return replaceItem(
      snapshot,
      turnId,
      itemId,
      { ...item, text: item.text + delta },
      false,
    );
  }
  if (item.type === 'plan') {
    return replaceItem(
      snapshot,
      turnId,
      itemId,
      { ...item, text: item.text + delta },
      false,
    );
  }
  return snapshot;
}

function appendCommandOutput(
  snapshot: ThreadSnapshot,
  turnId: string,
  itemId: string,
  delta: string,
): ThreadSnapshot {
  const turn = snapshot.turns.find((current) => current.id === turnId);
  const item = turn?.items.find((current) => current.id === itemId);
  if (item?.type !== 'commandExecution') return snapshot;
  return replaceItem(
    snapshot,
    turnId,
    itemId,
    { ...item, outputPreview: (item.outputPreview ?? '') + delta },
    false,
  );
}
