/** 协议 fixture 构造器:字段完整、可直接过 schema。 */
import type {
  ThreadItem,
  ThreadSnapshot,
  ThreadSummary,
  Turn,
  Usage,
} from '@ello/agent/protocol';

let counter = 0;
function seq(): number {
  counter += 1;
  return counter;
}

export const EMPTY_USAGE: Usage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
};

export function makeSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  const n = seq();
  return {
    id: `thread-${n}`,
    rootId: `thread-${n}`,
    cwd: '/tmp/project',
    name: '',
    preview: '',
    status: 'idle',
    archived: false,
    createdAt: '2026-07-22T08:00:00Z',
    updatedAt: '2026-07-22T08:00:00Z',
    ...overrides,
  };
}

export function makeTurn(overrides: Partial<Turn> & { readonly threadId: string }): Turn {
  const n = seq();
  return {
    id: `turn-${n}`,
    status: 'inProgress',
    items: [],
    startedAt: '2026-07-22T08:00:00Z',
    ...overrides,
  };
}

export function makeUserItem(turnId: string, text: string): ThreadItem {
  return {
    id: `item-${seq()}`,
    turnId,
    createdAt: '2026-07-22T08:00:00Z',
    type: 'userMessage',
    text,
  };
}

export function makeAgentItem(
  turnId: string,
  text: string,
  status: 'inProgress' | 'completed' = 'completed',
): ThreadItem {
  return {
    id: `item-${seq()}`,
    turnId,
    createdAt: '2026-07-22T08:00:00Z',
    type: 'agentMessage',
    text,
    phase: 'final',
    status,
  };
}

export function makeSnapshot(
  overrides: Partial<ThreadSnapshot> & { readonly thread: ThreadSummary },
): ThreadSnapshot {
  return {
    settings: {
      mode: 'ask-before-changes',
      profile: 'default',
      model: 'claude-opus-4-8',
      agent: 'default',
    },
    turns: [],
    pendingServerRequests: [],
    goal: null,
    plan: null,
    usage: EMPTY_USAGE,
    seq: 0,
    ...overrides,
  };
}
