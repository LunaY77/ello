import type { AgentError, AgentUsage } from '@ello/agent';

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

/** transcript（历史区）的一行。 */
export type TranscriptItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: ToolCallView }
  | { readonly kind: 'diagnostic'; readonly id: string; readonly text: string };

/** 待审批项在视图里的形状。 */
export interface ApprovalView {
  readonly requestId: string;
  readonly toolName: string;
  readonly input: unknown;
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

    case 'message.started':
      return { ...state, liveAssistantText: '' };

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
