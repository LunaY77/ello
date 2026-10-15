import type {
  Goal,
  ServerNotification,
  ThreadItem,
  ThreadSettings,
  ThreadSnapshot,
  ThreadStatus,
  Usage,
  UserInputResolution,
} from '../../api/protocol-types.js';
import { isToolItem } from '../../api/protocol-types.js';
import type { ClientServerRequest } from '../../api/server-requests.js';
import type { ThreadClientEvent } from '../../client/client-events.js';
import { applyNotification } from '../../client/event-reducer.js';

import { appendCommittedHistory } from './committed-history-store.js';
import type {
  CommandRunView,
  HistoryEntry,
  SubagentRunView,
  ToolCallView,
} from './history-entry.js';
import {
  itemToHistoryEntry,
  itemToCommandRunView,
  itemToSubagentView,
  itemToToolView,
  snapshotToHistoryEntries,
} from './history-replay.js';

export interface LiveRunState {
  readonly assistantText: string;
  readonly reasoningText: string;
  readonly compactionText: string;
  readonly runningTools: ReadonlyMap<string, ToolCallView>;
  readonly runningCommandRuns: ReadonlyMap<string, CommandRunView>;
  readonly runningSubagents: ReadonlyMap<string, SubagentRunView>;
}

/** 同时维护已提交 snapshot 与运行中 live 增量；只有完成事件能把两者合并。 */
export interface TuiEventState {
  readonly snapshot: ThreadSnapshot;
  readonly history: readonly HistoryEntry[];
  readonly live: LiveRunState;
  readonly status: ThreadStatus;
  readonly settings: ThreadSettings;
  readonly pendingRequest?: ClientServerRequest;
  readonly usage: Usage;
  readonly goal?: Goal;
  readonly activeTurnId?: string;
  readonly runStartedAt?: number;
  readonly interruptNotice?: string;
  readonly pendingSteers: ReadonlyArray<{
    readonly steerId: string;
    readonly text: string;
  }>;
  readonly stale: boolean;
  readonly historyResetKey: number;
}

export type TuiEventInput =
  | ThreadClientEvent
  | {
      readonly type: 'steer.queued';
      readonly steerId: string;
      readonly text: string;
    }
  | { readonly type: 'steer.failed'; readonly steerId: string }
  | {
      readonly type: 'ui.message';
      readonly text: string;
      readonly level?: 'info' | 'error';
    }
  | { readonly type: 'ui.compaction.started' }
  | {
      readonly type: 'ui.compaction.completed';
      readonly report: {
        readonly id: string;
        readonly summary: string;
        readonly tokensBefore: number;
        readonly beforeMessageCount: number;
        readonly afterMessageCount: number;
        readonly keptMessageCount: number;
      };
    }
  | { readonly type: 'ui.compaction.cleared' }
  | {
      readonly type: 'ui.subagent.committed';
      readonly entry: Extract<HistoryEntry, { readonly kind: 'subagent' }>;
    }
  | {
      readonly type: 'interaction.resolved';
      readonly requestId: string;
      readonly resolution?: UserInputResolution;
    };

export function createInitialTuiEventState(
  snapshot: ThreadSnapshot,
  serverVersion?: string,
): TuiEventState {
  const live = liveStateFromSnapshot(snapshot);
  const activeTurn = snapshot.turns.find(
    (turn) => turn.status === 'inProgress',
  );
  return {
    snapshot,
    history: snapshotToHistoryEntries(snapshot, serverVersion),
    live,
    status: snapshot.thread.status,
    settings: snapshot.settings,
    usage: snapshot.usage,
    ...(snapshot.goal === null ? {} : { goal: snapshot.goal }),
    ...(activeTurn === undefined
      ? {}
      : {
          activeTurnId: activeTurn.id,
          runStartedAt: Date.parse(activeTurn.startedAt),
        }),
    pendingSteers: [],
    stale: false,
    historyResetKey: 0,
  };
}

export function reduceTuiEvent(
  state: TuiEventState,
  event: TuiEventInput,
): TuiEventState {
  switch (event.type) {
    case 'snapshot': {
      const replacement = createInitialTuiEventState(event.snapshot);
      return { ...replacement, historyResetKey: state.historyResetKey + 1 };
    }
    case 'notification':
      return reduceServerNotification(state, event.notification);
    case 'serverRequest':
      return { ...state, pendingRequest: event.request };
    case 'stale':
      return { ...state, stale: true };
    case 'error':
      return appendHistory(state, {
        kind: 'diagnostic',
        id: `client-error-${state.history.length}`,
        text: event.error.message,
      });
    case 'connectionClosed': {
      const {
        activeTurnId: _activeTurnId,
        runStartedAt: _runStartedAt,
        pendingRequest: _pendingRequest,
        ...withoutRun
      } = state;
      return appendHistory(
        {
          ...withoutRun,
          snapshot: {
            ...state.snapshot,
            thread: { ...state.snapshot.thread, status: 'failed' },
          },
          live: emptyLiveState(),
          status: 'failed',
          pendingSteers: [],
          stale: true,
        },
        {
          kind: 'diagnostic',
          id: `connection-closed-${state.history.length}`,
          text: `App Server connection closed: ${event.error.message}`,
        },
      );
    }
    case 'steer.queued':
      return {
        ...state,
        pendingSteers: [
          ...state.pendingSteers,
          { steerId: event.steerId, text: event.text },
        ],
      };
    case 'steer.failed':
      return {
        ...state,
        pendingSteers: state.pendingSteers.filter(
          (steer) => steer.steerId !== event.steerId,
        ),
      };
    case 'ui.message':
      return appendHistory(state, {
        kind: event.level === 'error' ? 'diagnostic' : 'system',
        id: `ui-message-${state.history.length}`,
        text: event.text,
      });
    case 'ui.compaction.started':
      return {
        ...state,
        live: { ...state.live, compactionText: 'Compacting context…' },
      };
    case 'ui.compaction.completed':
      return appendHistory(
        {
          ...state,
          live: { ...state.live, compactionText: '' },
        },
        {
          kind: 'compaction',
          id: event.report.id,
          summary: event.report.summary,
          tokensBefore: event.report.tokensBefore,
          beforeMessageCount: event.report.beforeMessageCount,
          afterMessageCount: event.report.afterMessageCount,
          keptMessageCount: event.report.keptMessageCount,
        },
      );
    case 'ui.compaction.cleared':
      return {
        ...state,
        live: { ...state.live, compactionText: '' },
      };
    case 'ui.subagent.committed':
      return upsertSubagentHistory(state, event.entry);
    case 'interaction.resolved': {
      const request = state.pendingRequest;
      const next =
        request?.id === event.requestId ? omitPendingRequest(state) : state;
      if (
        request?.method === 'item/tool/requestUserInput' &&
        event.resolution !== undefined
      ) {
        return appendHistory(next, {
          kind: 'user_input',
          id: `user-input-${request.id}`,
          pending: request,
          resolution: event.resolution,
        });
      }
      return next;
    }
  }
}

function reduceServerNotification(
  state: TuiEventState,
  notification: ServerNotification,
): TuiEventState {
  if (
    !('threadId' in notification.params) ||
    notification.params.threadId !== state.snapshot.thread.id
  )
    return state;
  const before = state.snapshot;
  // 增量通知不复制 turns/items；item 完成或显式 snapshot 才推进持久化投影。
  const snapshot = isLiveDelta(notification)
    ? before
    : applyNotification(before, notification);
  const base: TuiEventState = {
    ...state,
    snapshot,
    status: snapshot.thread.status,
    settings: snapshot.settings,
    usage: snapshot.usage,
  };
  let next: TuiEventState =
    snapshot.goal === null ? omitGoal(base) : { ...base, goal: snapshot.goal };
  switch (notification.method) {
    case 'turn/started': {
      const { interruptNotice: _interruptNotice, ...withoutNotice } = next;
      return {
        ...withoutNotice,
        activeTurnId: notification.params.turnId,
        runStartedAt: Date.parse(notification.params.turn.startedAt),
        pendingSteers: [],
      };
    }
    case 'turn/completed': {
      const seconds = Math.max(
        0,
        Math.round(
          (Date.parse(
            notification.params.turn.completedAt ?? new Date().toISOString(),
          ) -
            Date.parse(notification.params.turn.startedAt)) /
            1000,
        ),
      );
      next = appendHistory(next, {
        kind: 'separator',
        id: `turn-separator-${notification.params.turnId}`,
        text:
          notification.params.turn.status === 'completed'
            ? `Worked for ${seconds}s`
            : `${notification.params.turn.status}: ${notification.params.turn.errorCode ?? 'turn ended'}`,
      });
      {
        const {
          activeTurnId: _activeTurnId,
          runStartedAt: _runStartedAt,
          interruptNotice: _interruptNotice,
          ...withoutTurn
        } = next;
        return {
          ...withoutTurn,
          live: emptyLiveState(),
          pendingSteers: [],
          ...(notification.params.turn.status === 'interrupted'
            ? {
                interruptNotice: `interrupted: ${notification.params.turn.errorCode ?? 'user request'}`,
              }
            : {}),
        };
      }
    }
    case 'item/started':
      return startLiveItem(next, notification.params.item);
    case 'item/agentMessage/delta':
    case 'item/plan/delta':
      return {
        ...next,
        live: {
          ...next.live,
          assistantText: next.live.assistantText + notification.params.delta,
        },
      };
    case 'item/reasoning/delta':
      return {
        ...next,
        live: {
          ...next.live,
          reasoningText: next.live.reasoningText + notification.params.delta,
        },
      };
    case 'item/commandExecution/outputDelta': {
      const tool = next.live.runningTools.get(notification.params.itemId);
      if (tool === undefined)
        throw new Error(
          `Command output without started item: ${notification.params.itemId}`,
        );
      const runningTools = new Map(next.live.runningTools);
      const previousOutput = parseCommandOutput(tool.output);
      runningTools.set(tool.id, {
        ...tool,
        output: {
          output: previousOutput.output + notification.params.delta,
          metadata: previousOutput.metadata,
        },
      });
      return { ...next, live: { ...next.live, runningTools } };
    }
    case 'item/completed': {
      if (findItem(before, notification.params.itemId) === undefined) {
        throw new Error(
          `Completed item without started item: ${notification.params.itemId}`,
        );
      }
      return completeItem(next, notification.params.item);
    }
    case 'item/updated': {
      if (notification.params.item.type !== 'commandRun') return next;
      const runningCommandRuns = new Map(next.live.runningCommandRuns);
      runningCommandRuns.set(
        notification.params.item.id,
        itemToCommandRunView(notification.params.item),
      );
      return { ...next, live: { ...next.live, runningCommandRuns } };
    }
    case 'serverRequest/resolved':
      return state.pendingRequest?.id === notification.params.requestId
        ? omitPendingRequest(next)
        : next;
    case 'thread/goal/updated':
    case 'thread/goal/cleared':
    case 'thread/sequence/advanced':
    case 'thread/tokenUsage/updated':
    case 'thread/status/changed':
    case 'thread/name/updated':
    case 'thread/settings/updated':
    case 'thread/plan/updated':
    case 'thread/archived':
    case 'thread/unarchived':
    case 'thread/started':
    case 'thread/closed':
    case 'thread/deleted':
    case 'turn/diff/updated':
      return next;
    case 'thread/compaction/updated':
      return next;
    case 'skills/changed':
    case 'fs/changed':
    case 'memory/job/updated':
    case 'agent/task/updated':
    case 'agent/task/event':
    case 'agent/task/removed':
    case 'warning':
    case 'server/ready':
      return state;
    default:
      notification satisfies never;
      throw new Error(`Unhandled notification: ${String(notification)}`);
  }
}

function startLiveItem(state: TuiEventState, item: ThreadItem): TuiEventState {
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return { ...state, live: { ...state.live, assistantText: item.text } };
  }
  if (item.type === 'reasoning') {
    return {
      ...state,
      live: { ...state.live, reasoningText: item.summary },
    };
  }
  if (item.type === 'commandRun') {
    const runningCommandRuns = new Map(state.live.runningCommandRuns);
    runningCommandRuns.set(item.id, itemToCommandRunView(item));
    return { ...state, live: { ...state.live, runningCommandRuns } };
  }
  if (isToolItem(item)) {
    const runningTools = new Map(state.live.runningTools);
    runningTools.set(item.id, itemToToolView(item));
    return { ...state, live: { ...state.live, runningTools } };
  }
  if (item.type === 'subagent') {
    const runningSubagents = new Map(state.live.runningSubagents);
    runningSubagents.set(item.id, itemToSubagentView(item));
    return { ...state, live: { ...state.live, runningSubagents } };
  }
  if (item.type === 'contextCompaction') {
    return {
      ...state,
      live: { ...state.live, compactionText: item.summary },
    };
  }
  return state;
}

function completeItem(state: TuiEventState, item: ThreadItem): TuiEventState {
  let next = state;
  if (item.type === 'userMessage' && item.steerId !== undefined) {
    next = {
      ...next,
      pendingSteers: next.pendingSteers.filter(
        (steer) => steer.steerId !== item.steerId,
      ),
    };
  } else if (item.type === 'agentMessage' || item.type === 'plan') {
    next = { ...next, live: { ...next.live, assistantText: '' } };
  } else if (item.type === 'reasoning') {
    next = { ...next, live: { ...next.live, reasoningText: '' } };
  } else if (item.type === 'contextCompaction') {
    next = { ...next, live: { ...next.live, compactionText: '' } };
  } else if (item.type === 'commandRun') {
    const runningCommandRuns = new Map(next.live.runningCommandRuns);
    runningCommandRuns.delete(item.id);
    next = { ...next, live: { ...next.live, runningCommandRuns } };
  } else if (isToolItem(item)) {
    const runningTools = new Map(next.live.runningTools);
    runningTools.delete(item.id);
    next = { ...next, live: { ...next.live, runningTools } };
  } else if (item.type === 'subagent') {
    const runningSubagents = new Map(next.live.runningSubagents);
    runningSubagents.delete(item.id);
    next = { ...next, live: { ...next.live, runningSubagents } };
  }
  const entry = itemToHistoryEntry(item);
  return entry === undefined ? next : appendHistory(next, entry);
}

function liveStateFromSnapshot(snapshot: ThreadSnapshot): LiveRunState {
  const live = emptyLiveState();
  let assistantText = '';
  let reasoningText = '';
  let compactionText = '';
  const runningTools = new Map<string, ToolCallView>();
  const runningCommandRuns = new Map<string, CommandRunView>();
  const runningSubagents = new Map<string, SubagentRunView>();
  for (const turn of snapshot.turns) {
    if (turn.status !== 'inProgress') continue;
    for (const item of turn.items) {
      if (!('status' in item) || item.status !== 'inProgress') continue;
      if (item.type === 'agentMessage' || item.type === 'plan')
        assistantText = item.text;
      else if (item.type === 'reasoning') reasoningText = item.summary;
      else if (item.type === 'contextCompaction') compactionText = item.summary;
      else if (item.type === 'commandRun')
        runningCommandRuns.set(item.id, itemToCommandRunView(item));
      else if (isToolItem(item))
        runningTools.set(item.id, itemToToolView(item));
      else if (item.type === 'subagent')
        runningSubagents.set(item.id, itemToSubagentView(item));
    }
  }
  return {
    ...live,
    assistantText,
    reasoningText,
    compactionText,
    runningTools,
    runningCommandRuns,
    runningSubagents,
  };
}

function emptyLiveState(): LiveRunState {
  return {
    assistantText: '',
    reasoningText: '',
    compactionText: '',
    runningTools: new Map(),
    runningCommandRuns: new Map(),
    runningSubagents: new Map(),
  };
}

function appendHistory(
  state: TuiEventState,
  entry: HistoryEntry,
): TuiEventState {
  if (state.history.some((candidate) => candidate.id === entry.id))
    return state;
  return {
    ...state,
    history: appendCommittedHistory({ entries: state.history }, entry).entries,
  };
}

function upsertSubagentHistory(
  state: TuiEventState,
  entry: Extract<HistoryEntry, { readonly kind: 'subagent' }>,
): TuiEventState {
  const index = state.history.findIndex(
    (candidate) => candidate.id === entry.id,
  );
  if (index === -1) return appendHistory(state, entry);
  const current = state.history[index];
  if (current?.kind !== 'subagent') return state;
  if (
    current.run.revision !== undefined &&
    entry.run.revision !== undefined &&
    entry.run.revision < current.run.revision
  ) {
    return state;
  }
  const history = [...state.history];
  history[index] = entry;
  return { ...state, history };
}

function findItem(
  snapshot: ThreadSnapshot,
  itemId: string,
): ThreadItem | undefined {
  return snapshot.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.id === itemId);
}

function omitPendingRequest(state: TuiEventState): TuiEventState {
  const { pendingRequest: _pendingRequest, ...rest } = state;
  return rest;
}

function omitGoal(state: TuiEventState): Omit<TuiEventState, 'goal'> {
  const { goal: _goal, ...rest } = state;
  return rest;
}

function isLiveDelta(notification: ServerNotification): boolean {
  return (
    notification.method === 'item/agentMessage/delta' ||
    notification.method === 'item/reasoning/delta' ||
    notification.method === 'item/plan/delta' ||
    notification.method === 'item/commandExecution/outputDelta'
  );
}

interface CommandOutput {
  readonly output: string;
  readonly metadata: Record<string, unknown>;
}

function parseCommandOutput(value: unknown): CommandOutput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('output' in value) ||
    typeof value.output !== 'string' ||
    !('metadata' in value) ||
    typeof value.metadata !== 'object' ||
    value.metadata === null ||
    !isRecord(value.metadata)
  ) {
    throw new Error('Command tool output does not match the TUI contract.');
  }
  return { output: value.output, metadata: value.metadata };
}

function isRecord(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}
