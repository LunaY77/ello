import type { AgentUsage } from '@ello/agent';

import type { GoalState } from '../../goal/types.js';
import type {
  CodingSessionEvent,
  CodingSessionState,
} from '../../runtime/intents.js';

import {
  appendCommittedHistory,
  emptyCommittedHistory,
  replaceCommittedHistory,
} from './committed-history-store.js';
import type {
  ApprovalView,
  HistoryEntry,
  SubagentRunView,
  ToolCallView,
} from './history-entry.js';
import { messagesToHistoryEntries } from './history-replay.js';

export interface LiveRunState {
  readonly assistantText: string;
  readonly runningTools: ReadonlyMap<string, ToolCallView>;
  readonly runningSubagents: ReadonlyMap<string, SubagentRunView>;
}

export interface TuiEventState {
  readonly history: readonly HistoryEntry[];
  readonly live: LiveRunState;
  readonly status: CodingSessionState;
  readonly pendingApproval?: ApprovalView;
  readonly usage?: AgentUsage;
  readonly goal?: GoalState;
  readonly interruptNotice?: string;
}

export const initialTuiEventState: TuiEventState = {
  history: emptyCommittedHistory.entries,
  live: {
    assistantText: '',
    runningTools: new Map(),
    runningSubagents: new Map(),
  },
  status: 'idle',
};

export interface PushUserAction {
  readonly type: 'user.input';
  readonly text: string;
}

export interface RunWorkedAction {
  readonly type: 'run.worked';
  readonly duration: string;
}

export type TuiEventInput =
  | CodingSessionEvent
  | PushUserAction
  | RunWorkedAction;

export function reduceTuiEvent(
  state: TuiEventState,
  event: TuiEventInput,
): TuiEventState {
  switch (event.type) {
    case 'user.input':
      return appendHistory(state, {
        kind: 'user',
        id: `user-${state.history.length}`,
        text: event.text,
      });

    case 'run.worked':
      return appendHistory(state, {
        kind: 'separator',
        id: `separator-${state.history.length}`,
        text: `Worked for ${event.duration}`,
      });

    case 'run.started':
    case 'turn.started':
    case 'turn.completed':
    case 'queue.drained':
      return state;

    case 'tool.approval_requested':
    case 'approval.required':
      return state;

    case 'ui.message':
      return appendHistory(state, {
        kind: 'system',
        id: `system-${state.history.length}`,
        text: event.text,
      });

    case 'ui.clear':
      return initialTuiEventState;

    case 'session.opened':
      return appendHistory(state, {
        kind: 'system',
        id: `session-opened-${state.history.length}`,
        text: `session opened: ${event.sessionId}`,
      });

    case 'session.switched':
      return appendHistory(state, {
        kind: 'system',
        id: `session-switched-${state.history.length}`,
        text: `session switched: ${event.sessionId}`,
      });

    case 'session.history.loaded':
      return {
        ...initialTuiEventState,
        history: replaceCommittedHistory(
          messagesToHistoryEntries(event.messages, event.entryIds),
        ).entries,
      };

    case 'session.rewound':
      return appendHistory(state, {
        kind: 'system',
        id: `session-rewound-${state.history.length}`,
        entryId: event.entryId,
        text: `rewound to ${event.entryId}`,
      });

    case 'session.summary.created':
      return appendHistory(state, {
        kind: 'system',
        id: `summary-${state.history.length}`,
        text: event.summary,
      });

    case 'session.title.updated':
      return state;

    case 'model.changed':
      return appendHistory(state, {
        kind: 'system',
        id: `model-${state.history.length}`,
        text: `model: ${event.model}`,
      });

    case 'context.source.loaded':
      return state;

    case 'context.source.failed':
      return appendHistory(state, {
        kind: 'diagnostic',
        id: `context-source-failed-${state.history.length}`,
        text: `context failed: ${event.origin}: ${event.error}`,
      });

    case 'context.compaction.started':
      return appendHistory(state, {
        kind: 'system',
        id: `context-compaction-started-${state.history.length}`,
        text: `compaction started: ${event.reason}`,
      });

    case 'context.compaction.completed':
      return appendHistory(state, {
        kind: 'system',
        id: `context-compaction-completed-${state.history.length}`,
        text: `compaction completed: ${event.summarizedMessages} summarized, ${event.keptMessages} kept`,
      });

    case 'memory.saved':
      return appendHistory(state, {
        kind: 'system',
        id: `memory-saved-${state.history.length}`,
        text: `memory ${event.operation}: ${event.scope}/${event.file}`,
      });

    case 'memory.extraction.started':
    case 'memory.dream.started':
      return state;

    case 'memory.extraction.completed':
      return event.changes === 0
        ? state
        : appendHistory(state, {
            kind: 'system',
            id: `memory-extraction-${state.history.length}`,
            text: `memory saved: ${event.changes} change${event.changes === 1 ? '' : 's'}`,
          });

    case 'memory.dream.completed':
      return appendHistory(state, {
        kind: 'system',
        id: `memory-dream-${state.history.length}`,
        text: `dream completed: ${event.changes} changes\n${event.summary}`,
      });

    case 'memory.extraction.failed':
    case 'memory.dream.failed':
      return appendHistory(state, {
        kind: 'diagnostic',
        id: `memory-failed-${state.history.length}`,
        text: `${event.type}: ${event.error}`,
      });

    case 'ui.interrupted':
      return {
        ...state,
        status: 'idle',
        interruptNotice: `interrupted: ${event.reason}`,
        live: emptyLiveRun(),
      };

    case 'run.interrupted':
      return {
        ...state,
        status: 'idle',
        interruptNotice: `interrupted: ${event.runId}`,
        live: emptyLiveRun(),
      };

    case 'message.started': {
      const flushed = flushAssistant(state);
      const { interruptNotice: _cleared, ...rest } = flushed;
      return {
        ...rest,
        live: { ...flushed.live, assistantText: '' },
      };
    }

    case 'message.delta':
      return {
        ...state,
        live: {
          ...state.live,
          assistantText: state.live.assistantText + event.text,
        },
      };

    case 'tool.started':
      return upsertTool(state, event.toolCallId, {
        id: event.toolCallId,
        name: event.name,
        input: event.input,
        status: 'running',
      });

    case 'tool.completed':
      return sealTool(state, event.toolCallId, {
        status: 'ok',
        output: event.output,
      });

    case 'tool.failed':
      return sealTool(state, event.toolCallId, {
        status: 'fail',
        error: event.error,
      });

    case 'subagent.started':
      return upsertSubagent(state, {
        runId: event.runId,
        agentName: event.agentName,
        description: event.description,
        background: event.background,
        status: 'running',
        startedAt: event.startedAt,
        tools: [],
      });

    case 'subagent.event':
      return updateSubagentEvent(state, event.runId, event.event);

    case 'subagent.completed':
      return sealSubagent(state, event.runId, {
        status: 'completed',
        output: event.output,
        completedAt: event.completedAt,
      });

    case 'subagent.failed':
      return sealSubagent(state, event.runId, {
        status: 'fail',
        error: event.error,
        completedAt: event.completedAt,
      });

    case 'subagent.background.completed':
      return sealSubagent(state, event.job.id, {
        status: event.job.status === 'completed' ? 'completed' : 'fail',
        ...(event.job.output !== undefined ? { output: event.job.output } : {}),
        ...(event.job.error !== undefined ? { error: event.job.error } : {}),
        ...(event.job.completedAt !== undefined
          ? { completedAt: event.job.completedAt }
          : {}),
      });

    case 'approval.pending':
      return {
        ...state,
        status: 'awaiting_approval',
        pendingApproval: {
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
        },
      };

    case 'status':
      if (event.state === 'awaiting_approval') {
        return { ...state, status: event.state };
      }
      {
        const { pendingApproval: _cleared, ...rest } = state;
        return { ...rest, status: event.state };
      }

    case 'usage':
      return { ...state, usage: event.usage };

    case 'goal.created':
      return {
        ...appendHistory(state, {
          kind: 'user',
          id: `goal-user-${state.history.length}`,
          text: event.goal.objective,
        }),
        goal: event.goal,
      };

    case 'goal.updated':
    case 'goal.continuation.started':
    case 'goal.continuation.completed':
    case 'goal.paused':
    case 'goal.completed':
    case 'goal.blocked':
      return { ...state, goal: event.goal };

    case 'goal.cleared': {
      const { goal: _goal, ...withoutGoal } = state;
      return withoutGoal;
    }

    case 'run.completed':
      return flushAssistant(state);

    case 'run.failed':
      return appendHistory(flushAssistant(state), {
        kind: 'diagnostic',
        id: `diag-${state.history.length}`,
        text: `run failed: ${event.error.message}`,
      });
  }
  return assertNever(event);
}

function emptyLiveRun(): LiveRunState {
  return {
    assistantText: '',
    runningTools: new Map(),
    runningSubagents: new Map(),
  };
}

function appendHistory(
  state: TuiEventState,
  entry: HistoryEntry,
): TuiEventState {
  return {
    ...state,
    history: appendCommittedHistory({ entries: state.history }, entry).entries,
  };
}

function flushAssistant(state: TuiEventState): TuiEventState {
  const text = state.live.assistantText.trim();
  if (text.trim() === '') {
    return state;
  }
  const last = state.history.at(-1);
  if (last?.kind === 'assistant' && last.text === text) {
    return {
      ...state,
      live: { ...state.live, assistantText: '' },
    };
  }
  return {
    ...appendHistory(state, {
      kind: 'assistant',
      id: `assistant-${state.history.length}`,
      text,
    }),
    live: { ...state.live, assistantText: '' },
  };
}

function upsertTool(
  state: TuiEventState,
  id: string,
  tool: ToolCallView,
): TuiEventState {
  const next = new Map(state.live.runningTools);
  next.set(id, tool);
  return { ...state, live: { ...state.live, runningTools: next } };
}

function sealTool(
  state: TuiEventState,
  id: string,
  patch: Pick<ToolCallView, 'status'> & Partial<ToolCallView>,
): TuiEventState {
  const existing = state.live.runningTools.get(id);
  if (existing === undefined) {
    throw new Error(`Tool completed before start: ${id}`);
  }
  const sealed: ToolCallView = { ...existing, ...patch };
  const next = new Map(state.live.runningTools);
  next.delete(id);
  return appendHistory(
    { ...state, live: { ...state.live, runningTools: next } },
    { kind: 'tool', id, tool: sealed },
  );
}

function upsertSubagent(
  state: TuiEventState,
  run: SubagentRunView,
): TuiEventState {
  const next = new Map(state.live.runningSubagents);
  next.set(run.runId, run);
  return { ...state, live: { ...state.live, runningSubagents: next } };
}

function updateSubagentEvent(
  state: TuiEventState,
  runId: string,
  event: Extract<CodingSessionEvent, { type: 'subagent.event' }>['event'],
): TuiEventState {
  const run = state.live.runningSubagents.get(runId);
  if (run === undefined) {
    throw new Error(`Subagent event before start: ${runId}`);
  }
  switch (event.type) {
    case 'tool.started':
      return upsertSubagent(state, {
        ...run,
        tools: upsertToolList(run.tools, {
          id: event.toolCallId,
          name: event.name,
          input: event.input,
          status: 'running',
        }),
      });
    case 'tool.completed':
      return upsertSubagent(state, {
        ...run,
        tools: patchToolList(run.tools, event.toolCallId, {
          status: 'ok',
          output: event.output,
        }),
      });
    case 'tool.failed':
      return upsertSubagent(state, {
        ...run,
        tools: patchToolList(run.tools, event.toolCallId, {
          status: 'fail',
          error: event.error,
        }),
      });
    case 'run.started':
    case 'turn.started':
    case 'queue.drained':
    case 'message.started':
    case 'message.delta':
    case 'tool.approval_requested':
    case 'approval.required':
    case 'turn.completed':
    case 'run.interrupted':
    case 'run.completed':
    case 'run.failed':
      return state;
  }
  return assertNever(event);
}

function sealSubagent(
  state: TuiEventState,
  runId: string,
  patch: Pick<SubagentRunView, 'status'> & Partial<SubagentRunView>,
): TuiEventState {
  const existing = state.live.runningSubagents.get(runId);
  if (existing === undefined) {
    throw new Error(`Subagent completed before start: ${runId}`);
  }
  const sealed: SubagentRunView = { ...existing, ...patch };
  const next = new Map(state.live.runningSubagents);
  next.delete(runId);
  return appendHistory(
    { ...state, live: { ...state.live, runningSubagents: next } },
    { kind: 'subagent', id: `subagent-${runId}`, run: sealed },
  );
}

function upsertToolList(
  tools: readonly ToolCallView[],
  tool: ToolCallView,
): readonly ToolCallView[] {
  const index = tools.findIndex((item) => item.id === tool.id);
  if (index === -1) {
    return [...tools, tool];
  }
  return tools.map((item, current) => (current === index ? tool : item));
}

function patchToolList(
  tools: readonly ToolCallView[],
  toolCallId: string,
  patch: Pick<ToolCallView, 'status'> & Partial<ToolCallView>,
): readonly ToolCallView[] {
  const found = tools.some((tool) => tool.id === toolCallId);
  if (!found) {
    throw new Error(`Subagent tool completed before start: ${toolCallId}`);
  }
  return tools.map((tool) =>
    tool.id === toolCallId ? { ...tool, ...patch } : tool,
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled TUI event: ${JSON.stringify(value)}`);
}
