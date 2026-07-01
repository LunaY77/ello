import type { AgentError, AgentMessage, AgentUsage } from '@ello/agent';

import type {
  CodingSessionEvent,
  CodingSessionState,
} from '../../runtime/intents.js';

/** 单个工具调用在视图里的折叠态。 */
export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: 'running' | 'ok' | 'fail';
  readonly output?: unknown;
  readonly error?: AgentError;
}

export interface ToolResultView {
  readonly kind?: string;
  readonly title?: string;
  readonly output?: string;
  readonly metadata?: Record<string, unknown>;
}

/** transcript（历史区）的一行。 */
export type TranscriptItem =
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly entryId?: string | undefined;
      readonly text: string;
    }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly entryId?: string | undefined;
      readonly text: string;
    }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: ToolCallView }
  | {
      readonly kind: 'system';
      readonly id: string;
      readonly entryId?: string | undefined;
      readonly text: string;
    }
  | { readonly kind: 'diagnostic'; readonly id: string; readonly text: string };

/** 待审批项在视图里的形状。 */
export interface ApprovalView {
  readonly requestId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly metadata?: Record<string, unknown>;
}

/**
 * 把 {@link CodingSessionEvent} 折叠成可渲染状态。
 *
 * 这是 TUI **唯一**的事件→状态映射。reducer 的输入直接是共享运行时的事件，不再
 * 经过任何中间事件体系。把“流”与“React 渲染”解耦后，也便于用
 * `ink-testing-library` 单测。
 */
export interface ViewState {
  /** 已结案的历史行（用户/助手/工具/诊断）。 */
  readonly transcript: readonly TranscriptItem[];
  /** 当前 turn 累积的助手增量文本（未结案）。 */
  readonly liveAssistantText: string;
  /** 运行中的工具调用，按 toolCallId 索引。 */
  readonly runningTools: ReadonlyMap<string, ToolCallView>;
  readonly status: CodingSessionState;
  readonly pendingApproval?: ApprovalView;
  readonly usage?: AgentUsage;
  readonly interruptNotice?: string;
}

/** 初始空状态。 */
export const initialViewState: ViewState = {
  transcript: [],
  liveAssistantText: '',
  runningTools: new Map(),
  status: 'idle',
};

/** 把用户输入即时落到 transcript（提交时由 App 主动派发）。 */
export interface PushUserAction {
  readonly type: 'user.input';
  readonly text: string;
}

/** reducer 接受的输入：会话事件 或 本地 UI 动作。 */
export type ViewInput = CodingSessionEvent | PushUserAction;

/**
 * 视图 reducer：纯函数，无副作用。
 */
export function reduce(state: ViewState, event: ViewInput): ViewState {
  switch (event.type) {
    case 'user.input':
      return appendTranscript(state, {
        kind: 'user',
        id: `user-${state.transcript.length}`,
        text: event.text,
      });

    case 'ui.message':
      return appendTranscript(state, {
        kind: 'system',
        id: `system-${state.transcript.length}`,
        text: event.text,
      });

    case 'ui.clear':
      return initialViewState;

    case 'session.history.loaded':
      return {
        ...initialViewState,
        transcript: messagesToTranscript(event.messages, event.entryIds),
      };

    case 'session.summary.created':
      return appendTranscript(state, {
        kind: 'system',
        id: `summary-${state.transcript.length}`,
        text: event.summary,
      });

    case 'ui.interrupted':
      return {
        ...state,
        status: 'idle',
        interruptNotice: `interrupted: ${event.reason}`,
        liveAssistantText: '',
        runningTools: new Map(),
      };

    case 'message.started': {
      const { interruptNotice: _cleared, ...rest } = state;
      return { ...rest, liveAssistantText: '' };
    }

    case 'message.delta':
      return {
        ...state,
        liveAssistantText: state.liveAssistantText + event.text,
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

    case 'status': {
      // 状态切换会清掉 awaiting_approval 时遗留的待审批项。
      if (event.state === 'awaiting_approval') {
        return { ...state, status: event.state };
      }
      const { pendingApproval: _cleared, ...rest } = state;
      return { ...rest, status: event.state };
    }

    case 'usage':
      return { ...state, usage: event.usage };

    case 'run.completed':
      // run 结束：把累积的助手文本结案进 transcript。
      return flushAssistant(state);

    case 'run.failed':
      return appendTranscript(flushAssistant(state), {
        kind: 'diagnostic',
        id: `diag-${state.transcript.length}`,
        text: `run failed: ${event.error.message}`,
      });

    default:
      return state;
  }
}

function messagesToTranscript(
  messages: readonly AgentMessage[],
  entryIds: readonly string[] | undefined,
): readonly TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolCalls = new Map<
    string,
    { readonly id: string; readonly name: string; readonly input: unknown }
  >();
  messages.forEach((message, index) => {
    for (const call of readToolCalls(message)) {
      toolCalls.set(call.id, call);
    }
    const results = readToolResults(message);
    if (results.length > 0) {
      for (const result of results) {
        const call = toolCalls.get(result.id);
        items.push({
          kind: 'tool',
          id: `history-tool-${index}-${result.id}`,
          tool: {
            id: result.id,
            name: call?.name ?? result.name ?? 'tool',
            input: call?.input ?? {},
            status: result.status,
            ...(result.output !== undefined ? { output: result.output } : {}),
          },
        });
      }
      return;
    }
    if (readToolCalls(message).length > 0) {
      return;
    }
    const text = messageContentText(message);
    if (!text.trim()) {
      return;
    }
    if (message.role === 'user') {
      items.push({
        kind: 'user',
        id: `history-user-${index}`,
        ...(entryIds?.[index] !== undefined ? { entryId: entryIds[index] } : {}),
        text,
      });
      return;
    }
    if (message.role === 'assistant') {
      items.push({
        kind: 'assistant',
        id: `history-assistant-${index}`,
        ...(entryIds?.[index] !== undefined ? { entryId: entryIds[index] } : {}),
        text,
      });
      return;
    }
    items.push({
      kind: 'system',
      id: `history-message-${index}`,
      ...(entryIds?.[index] !== undefined ? { entryId: entryIds[index] } : {}),
      text,
    });
  });
  return items;
}

function messageContentText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function readToolCalls(message: AgentMessage): Array<{
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}> {
  if (message.role !== 'assistant') {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== 'tool-call') {
      return [];
    }
    const id = readString(part.toolCallId ?? part.id);
    const name = readString(part.toolName ?? part.name);
    if (id === undefined || name === undefined) {
      return [];
    }
    return [{ id, name, input: part.input ?? part.args ?? {} }];
  });
}

function readToolResults(message: AgentMessage): Array<{
  readonly id: string;
  readonly name?: string;
  readonly output?: unknown;
  readonly status: ToolCallView['status'];
}> {
  if (message.role !== 'tool') {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== 'tool-result') {
      return [];
    }
    const id = readString(part.toolCallId ?? part.id);
    if (id === undefined) {
      return [];
    }
    const output = part.output;
    const name = readString(part.toolName ?? part.name);
    return [
      {
        id,
        ...(name !== undefined ? { name } : {}),
        ...(output !== undefined
          ? { output: normalizeToolOutput(output) }
          : {}),
        status: isToolErrorOutput(output) ? 'fail' : 'ok',
      },
    ];
  });
}

function normalizeToolOutput(output: unknown): unknown {
  if (!isRecord(output)) {
    return output;
  }
  if (output.type === 'text') {
    return output.value;
  }
  if (output.type === 'json') {
    return normalizeToolOutput(output.value);
  }
  if (output.type === 'error-text') {
    return output.value;
  }
  return output;
}

function isToolErrorOutput(output: unknown): boolean {
  return isRecord(output) && output.type === 'error-text';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 追加一行 transcript。 */
function appendTranscript(state: ViewState, item: TranscriptItem): ViewState {
  return { ...state, transcript: [...state.transcript, item] };
}

/** 把当前助手增量文本结案为一条 transcript 行并清空 live。 */
function flushAssistant(state: ViewState): ViewState {
  if (state.liveAssistantText.trim() === '') {
    return state;
  }
  return {
    ...appendTranscript(state, {
      kind: 'assistant',
      id: `assistant-${state.transcript.length}`,
      text: state.liveAssistantText,
    }),
    liveAssistantText: '',
  };
}

/** 新增/更新一个运行中工具。 */
function upsertTool(
  state: ViewState,
  id: string,
  tool: ToolCallView,
): ViewState {
  const next = new Map(state.runningTools);
  next.set(id, tool);
  return { ...state, runningTools: next };
}

/**
 * 工具结案：从 running 集合移除，并把结果写进 transcript 折叠卡片。
 */
function sealTool(
  state: ViewState,
  id: string,
  patch: Pick<ToolCallView, 'status'> & Partial<ToolCallView>,
): ViewState {
  const existing = state.runningTools.get(id);
  if (existing === undefined) {
    return state;
  }
  const sealed: ToolCallView = { ...existing, ...patch };
  const next = new Map(state.runningTools);
  next.delete(id);
  return appendTranscript(
    { ...state, runningTools: next },
    { kind: 'tool', id, tool: sealed },
  );
}
