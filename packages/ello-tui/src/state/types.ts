import type {
  CodingAgentConfig,
  CodingAgentEvent,
  JsonlSessionSummary,
  SlashCommandResult,
  TaskRecord,
} from '@ello/coding-agent';

export type OverlayKind = 'sessions' | 'model' | 'settings' | 'commands' | null;

export interface ToolCard {
  toolCallId: string;
  toolName: string;
  status: 'started' | 'finished';
  args: unknown | undefined;
  result: unknown | undefined;
  isError: boolean | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  durationMs: number | undefined;
}

export interface TranscriptItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  text: string;
}

export interface TuiState {
  transcript: TranscriptItem[];
  status: 'ready' | 'running' | 'approval' | 'error';
  currentRun: { runId: string; input: string } | null;
  model: string;
  models: string[];
  modelIndex: number;
  sessionId: string;
  pendingApproval: Extract<CodingAgentEvent, { type: 'approval_request' }> | null;
  tools: Record<string, ToolCard>;
  tasks: TaskRecord[];
  sessions: JsonlSessionSummary[];
  sessionIndex: number;
  overlay: OverlayKind;
  usageText: string;
  usageTotals: string;
  history: string[];
  historyIndex: number | null;
  composer: string;
  approvalDraft: string;
  approvalEditing: boolean;
  exitPending: boolean;
}

export type TuiAction =
  | { type: 'append'; item: TranscriptItem }
  | { type: 'slash'; command: SlashCommandResult }
  | { type: 'event'; event: CodingAgentEvent }
  | { type: 'sessions'; sessions: JsonlSessionSummary[] }
  | { type: 'session_prev' }
  | { type: 'session_next' }
  | { type: 'models'; models: string[] }
  | { type: 'model_prev' }
  | { type: 'model_next' }
  | { type: 'overlay'; overlay: OverlayKind }
  | { type: 'composer_set'; value: string }
  | { type: 'approval_draft'; value: string }
  | { type: 'approval_editing'; value: boolean }
  | { type: 'exit_pending'; value: boolean }
  | { type: 'history_push'; value: string }
  | { type: 'history_prev' }
  | { type: 'history_next' }
  | { type: 'approval_cleared' };

/**
 * 为新的 Ink 会话构建初始状态。
 */
export function createInitialState(config: CodingAgentConfig): TuiState {
  return {
    transcript: [systemItem(`ello ${config.model} ${config.cwd}`)],
    status: 'ready',
    currentRun: null,
    model: config.model,
    models: [config.model, ...config.modelCandidates].filter(
      (model, index, models) => models.indexOf(model) === index,
    ),
    modelIndex: 0,
    sessionId: config.sessionId ?? 'new',
    pendingApproval: null,
    tools: {},
    tasks: [],
    sessions: [],
    sessionIndex: 0,
    overlay: null,
    usageText: 'usage pending',
    usageTotals: '0 req / 0 in / 0 out / 0 cache / 0 tool',
    history: [],
    historyIndex: null,
    composer: '',
    approvalDraft: '',
    approvalEditing: false,
    exitPending: false,
  };
}

export function systemItem(text: string): TranscriptItem {
  return { id: `system_${nextItemId()}`, role: 'system', text };
}

export function userItem(text: string): TranscriptItem {
  return { id: `user_${nextItemId()}`, role: 'user', text };
}

export function assistantItem(text: string): TranscriptItem {
  return { id: `assistant_${nextItemId()}`, role: 'assistant', text };
}

export function toolItem(text: string): TranscriptItem {
  return { id: `tool_${nextItemId()}`, role: 'tool', text };
}

export function errorItem(text: string): TranscriptItem {
  return { id: `error_${nextItemId()}`, role: 'error', text };
}

let itemCounter = 0;

function nextItemId(): string {
  itemCounter += 1;
  return `${Date.now().toString(36)}_${itemCounter.toString(36)}`;
}
