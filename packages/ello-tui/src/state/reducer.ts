import type { CodingAgentEvent } from '@ello/coding-agent';

import {
  assistantItem,
  errorItem,
  systemItem,
  toolItem,
  type TuiAction,
  type TuiState,
} from './types.js';

/**
 * 纯 reducer：将 agent 和 UI action 映射为新的 TUI 状态。
 */
export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  if (action.type === 'append') {
    return { ...state, transcript: [...state.transcript, action.item] };
  }
  if (action.type === 'overlay') {
    return { ...state, overlay: action.overlay };
  }
  if (action.type === 'sessions') {
    return { ...state, sessions: action.sessions, sessionIndex: 0 };
  }
  if (action.type === 'session_prev') {
    if (state.sessions.length === 0) return state;
    return {
      ...state,
      sessionIndex: state.sessionIndex <= 0 ? state.sessions.length - 1 : state.sessionIndex - 1,
    };
  }
  if (action.type === 'session_next') {
    if (state.sessions.length === 0) return state;
    return {
      ...state,
      sessionIndex: state.sessionIndex >= state.sessions.length - 1 ? 0 : state.sessionIndex + 1,
    };
  }
  if (action.type === 'models') {
    return {
      ...state,
      models: action.models,
      modelIndex: Math.max(0, action.models.indexOf(state.model)),
    };
  }
  if (action.type === 'model_prev') {
    if (state.models.length === 0) return state;
    return {
      ...state,
      modelIndex: state.modelIndex <= 0 ? state.models.length - 1 : state.modelIndex - 1,
    };
  }
  if (action.type === 'model_next') {
    if (state.models.length === 0) return state;
    return {
      ...state,
      modelIndex: state.modelIndex >= state.models.length - 1 ? 0 : state.modelIndex + 1,
    };
  }
  if (action.type === 'history_push') {
    return {
      ...state,
      history: [...state.history.filter((item) => item !== action.value), action.value],
      historyIndex: null,
    };
  }
  if (action.type === 'history_prev') {
    if (state.history.length === 0) {
      return state;
    }
    const nextIndex =
      state.historyIndex === null ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
    return { ...state, historyIndex: nextIndex };
  }
  if (action.type === 'history_next') {
    if (state.historyIndex === null) {
      return state;
    }
    const nextIndex =
      state.historyIndex >= state.history.length - 1 ? null : state.historyIndex + 1;
    return { ...state, historyIndex: nextIndex };
  }
  if (action.type === 'composer_set') {
    return { ...state, composer: action.value };
  }
  if (action.type === 'approval_draft') {
    return { ...state, approvalDraft: action.value };
  }
  if (action.type === 'approval_editing') {
    return { ...state, approvalEditing: action.value };
  }
  if (action.type === 'exit_pending') {
    return { ...state, exitPending: action.value };
  }
  if (action.type === 'approval_cleared') {
    return {
      ...state,
      pendingApproval: null,
      status: 'running',
      approvalDraft: '',
      approvalEditing: false,
      exitPending: false,
    };
  }
  if (action.type === 'slash') {
    if (!action.command.handled) {
      return state;
    }
    if (action.command.command === 'clear') {
      return { ...state, transcript: [] };
    }
    return action.command.output
      ? { ...state, transcript: [...state.transcript, systemItem(action.command.output)] }
      : state;
  }

  return reduceEvent(state, action.event);
}

function reduceEvent(state: TuiState, event: CodingAgentEvent): TuiState {
  if (event.type === 'session_started') {
    return { ...state, sessionId: event.sessionId, model: event.config.model };
  }
  if (event.type === 'usage_snapshot') {
    return {
      ...state,
      usageText: formatUsageText(event.totalUsage),
      usageTotals: formatUsageTotals(event.totalUsage),
    };
  }
  if (event.type === 'run_started') {
    return {
      ...state,
      status: 'running',
      currentRun: { runId: event.runId, input: event.input },
      pendingApproval: null,
      exitPending: false,
    };
  }
  if (event.type === 'run_finished') {
    return {
      ...state,
      status: event.success ? 'ready' : 'error',
      currentRun: null,
      transcript:
        event.success || !event.error
          ? state.transcript
          : [...state.transcript, errorItem(event.error)],
    };
  }
  if (event.type === 'tool_display') {
    const previous = state.tools[event.toolCallId];
    const nextCard = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: event.status,
      args: event.args ?? previous?.args,
      result: event.result ?? previous?.result,
      isError: event.isError ?? previous?.isError,
      startedAt: event.startedAt ?? previous?.startedAt,
      finishedAt: event.finishedAt ?? previous?.finishedAt,
      durationMs: event.durationMs ?? previous?.durationMs,
    };
    return {
      ...state,
      tools: {
        ...state.tools,
        [event.toolCallId]: nextCard,
      },
      transcript: [
        ...state.transcript,
        toolItem(`${event.toolName} ${event.status}${event.isError ? ' error' : ''}`),
      ],
    };
  }
  if (event.type === 'approval_request') {
    return {
      ...state,
      status: 'approval',
      pendingApproval: event,
      approvalDraft: JSON.stringify(event.input, null, 2),
      approvalEditing: false,
      transcript: [...state.transcript, systemItem(`approval required: ${event.toolName}`)],
    };
  }
  if (event.type === 'task_snapshot') {
    return { ...state, tasks: event.tasks };
  }
  if (event.type === 'sessions_listed') {
    return { ...state, sessions: event.sessions, overlay: 'sessions' };
  }
  if (event.type === 'model_switched') {
    return {
      ...state,
      model: event.model,
      modelIndex: Math.max(0, state.models.indexOf(event.model)),
    };
  }
  const text = eventToText(event);
  return text ? appendAssistantText(state, text) : state;
}

function eventToText(event: CodingAgentEvent): string | null {
  if (event.type === 'core_event' && event.event.type === 'message_delta') {
    const delta = event.event.delta;
    return delta.type === 'text' && delta.text ? delta.text : null;
  }
  if (event.type === 'diagnostic') {
    return event.message;
  }
  if (event.type === 'memory_loaded') {
    return `memory loaded: ${event.files.length} files`;
  }
  if (event.type === 'compacted') {
    return event.message;
  }
  return null;
}

function appendAssistantText(state: TuiState, text: string): TuiState {
  const last = state.transcript.at(-1);
  if (last?.role === 'assistant') {
    return {
      ...state,
      transcript: [
        ...state.transcript.slice(0, -1),
        assistantItem(`${last.text}${text}`),
      ],
    };
  }
  return { ...state, transcript: [...state.transcript, assistantItem(text)] };
}

function formatUsageText(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
}): string {
  return `usage ${
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens +
    usage.toolCalls
  }`;
}

function formatUsageTotals(usage: {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
}): string {
  return `${usage.requests} req / ${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.cacheReadTokens + usage.cacheWriteTokens} cache / ${usage.toolCalls} tool`;
}
