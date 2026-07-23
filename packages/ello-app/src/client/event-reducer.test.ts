import type { ServerNotification } from '@ello/agent/protocol';
import { describe, expect, it } from 'vitest';

import { applyStoreEvent, ProtocolViolationError } from './event-reducer';

import { initialState } from '@/store/store';
import type { AppState } from '@/store/types';
import {
  makeAgentItem,
  makeSnapshot,
  makeSummary,
  makeTurn,
  makeUserItem,
} from '@/testing/fixtures';

function stateWith(snapshot: ReturnType<typeof makeSnapshot>): AppState {
  return applyStoreEvent(initialState, { kind: 'snapshot-loaded', snapshot });
}

function notify(state: AppState, notification: ServerNotification): AppState {
  return applyStoreEvent(state, {
    kind: 'notification',
    notification,
    receivedAt: 1_000,
  });
}

describe('event-reducer · snapshot-loaded', () => {
  it('替换快照并重建待审批队列(解析 params)', () => {
    const summary = makeSummary();
    const snapshot = makeSnapshot({
      thread: summary,
      pendingServerRequests: [
        {
          id: 'srvreq_1',
          method: 'item/commandExecution/requestApproval',
          threadId: summary.id,
          turnId: 'turn-1',
          itemId: 'item-1',
          params: {
            threadId: summary.id,
            turnId: 'turn-1',
            itemId: 'item-1',
            reason: '需要运行测试',
            availableDecisions: ['accept', 'decline', 'cancel'],
            command: ['pnpm', 'test'],
            cwd: '/tmp/project',
          },
          createdAt: '2026-07-22T08:00:00Z',
        },
      ],
    });
    const state = applyStoreEvent(initialState, {
      kind: 'snapshot-loaded',
      snapshot,
    });
    expect(state.entities.snapshots[summary.id]?.thread.id).toBe(summary.id);
    expect(state.interaction.pendingRequests).toHaveLength(1);
    const entry = state.interaction.pendingRequests[0];
    expect(entry?.method).toBe('item/commandExecution/requestApproval');
    expect(entry?.state).toBe('pending');
  });

  it('快照携带未知 server request method 时抛协议违约', () => {
    const summary = makeSummary();
    const snapshot = makeSnapshot({
      thread: summary,
      pendingServerRequests: [
        {
          id: 'srvreq_x',
          method: 'item/unknown/method',
          threadId: summary.id,
          turnId: 't',
          itemId: 'i',
          params: {},
          createdAt: '2026-07-22T08:00:00Z',
        },
      ],
    });
    expect(() =>
      applyStoreEvent(initialState, { kind: 'snapshot-loaded', snapshot }),
    ).toThrow(ProtocolViolationError);
  });
});

describe('event-reducer · seq 语义', () => {
  it('正常推进:turn/started 追加并推进 seq', () => {
    const summary = makeSummary();
    const snapshot = makeSnapshot({ thread: summary, seq: 0 });
    let state = stateWith(snapshot);
    const turn = makeTurn({ threadId: summary.id });
    state = notify(state, {
      method: 'turn/started',
      params: { threadId: summary.id, turnId: turn.id, seq: 1, turn },
    });
    expect(state.entities.snapshots[summary.id]?.turns).toHaveLength(1);
    expect(state.entities.snapshots[summary.id]?.seq).toBe(1);
  });

  it('barrier 滞留的重复事件(seq <= 当前)整条跳过', () => {
    const summary = makeSummary();
    const turn = makeTurn({ threadId: summary.id, status: 'completed' });
    const snapshot = makeSnapshot({ thread: summary, seq: 3, turns: [turn] });
    const state = stateWith(snapshot);
    // 同一 turn 以 inProgress 重放:必须被忽略。
    const replayed = { ...turn, status: 'inProgress' as const };
    const next = notify(state, {
      method: 'turn/started',
      params: { threadId: summary.id, turnId: turn.id, seq: 2, turn: replayed },
    });
    expect(next.entities.snapshots[summary.id]?.turns[0]?.status).toBe(
      'completed',
    );
  });

  it('断层直接抛协议违约', () => {
    const summary = makeSummary();
    const snapshot = makeSnapshot({ thread: summary, seq: 0 });
    const state = stateWith(snapshot);
    expect(() =>
      notify(state, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: summary.id,
          turnId: 'missing-turn',
          seq: 9,
          itemId: 'missing-item',
          delta: 'x',
        },
      }),
    ).toThrow(ProtocolViolationError);
  });

  it('严格态下 item 事件引用未知 turn 直接抛错', () => {
    const summary = makeSummary();
    const snapshot = makeSnapshot({ thread: summary, seq: 0 });
    const state = stateWith(snapshot);
    const item = makeAgentItem('unknown-turn', 'hi');
    expect(() =>
      notify(state, {
        method: 'item/started',
        params: {
          threadId: summary.id,
          turnId: 'unknown-turn',
          seq: 1,
          itemId: item.id,
          item,
        },
      }),
    ).toThrow(ProtocolViolationError);
  });

  it('delta 追加到 agentMessage 文本', () => {
    const summary = makeSummary();
    const turn = makeTurn({ threadId: summary.id });
    const item = makeAgentItem(turn.id, '你好', 'inProgress');
    const snapshot = makeSnapshot({
      thread: summary,
      seq: 1,
      turns: [{ ...turn, items: [item] }],
    });
    let state = stateWith(snapshot);
    state = notify(state, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: summary.id,
        turnId: turn.id,
        seq: 2,
        itemId: item.id,
        delta: '世界',
      },
    });
    const stored = state.entities.snapshots[summary.id]?.turns[0]?.items[0];
    expect(stored?.type === 'agentMessage' && stored.text).toBe('你好世界');
  });

  it('delta 指向错误类型 item 抛协议违约', () => {
    const summary = makeSummary();
    const turn = makeTurn({ threadId: summary.id });
    const item = makeUserItem(turn.id, 'hi');
    const snapshot = makeSnapshot({
      thread: summary,
      seq: 1,
      turns: [{ ...turn, items: [item] }],
    });
    const state = stateWith(snapshot);
    expect(() =>
      notify(state, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: summary.id,
          turnId: turn.id,
          seq: 2,
          itemId: item.id,
          delta: 'x',
        },
      }),
    ).toThrow(ProtocolViolationError);
  });
});

describe('event-reducer · server request 生命周期', () => {
  it('live 到达入队,resolved 通知出队', () => {
    const summary = makeSummary();
    const snapshot = makeSnapshot({ thread: summary, seq: 0 });
    let state = stateWith(snapshot);
    state = applyStoreEvent(state, {
      kind: 'server-request-received',
      entry: {
        id: 'srvreq_9',
        method: 'item/plan/requestApproval',
        threadId: summary.id,
        turnId: 'turn-1',
        itemId: 'item-1',
        params: {
          threadId: summary.id,
          turnId: 'turn-1',
          itemId: 'item-1',
          reason: '',
          availableDecisions: ['accept', 'decline', 'cancel'] as const,
          contentHash: 'abc',
          preview: 'plan',
        },
        createdAt: '2026-07-22T08:00:00Z',
        state: 'pending',
      },
    });
    expect(state.interaction.pendingRequests).toHaveLength(1);
    state = notify(state, {
      method: 'serverRequest/resolved',
      params: {
        threadId: summary.id,
        turnId: 'turn-1',
        seq: 1,
        itemId: 'item-1',
        requestId: 'srvreq_9',
      },
    });
    expect(state.interaction.pendingRequests).toHaveLength(0);
  });

  it('重复 server request id 抛协议违约', () => {
    const entry = {
      id: 'srvreq_1',
      method: 'item/plan/requestApproval' as const,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: '',
        availableDecisions: ['accept'] as const,
        contentHash: 'abc',
        preview: 'p',
      },
      createdAt: '2026-07-22T08:00:00Z',
      state: 'pending' as const,
    };
    const state = applyStoreEvent(initialState, {
      kind: 'server-request-received',
      entry,
    });
    expect(() =>
      applyStoreEvent(state, { kind: 'server-request-received', entry }),
    ).toThrow(ProtocolViolationError);
  });

  it('更新未知 server request 状态时抛协议违约', () => {
    expect(() =>
      applyStoreEvent(initialState, {
        kind: 'server-request-state',
        requestId: 'srvreq_missing',
        state: 'responding',
      }),
    ).toThrow(ProtocolViolationError);
  });
});

describe('event-reducer · thread 生命周期', () => {
  it('thread/deleted 清除 summary、快照与待审批', () => {
    const summary = makeSummary();
    const snapshot = makeSnapshot({ thread: summary, seq: 0 });
    let state = stateWith(snapshot);
    state = applyStoreEvent(state, {
      kind: 'thread-removed',
      threadId: summary.id,
    });
    expect(state.entities.threads[summary.id]).toBeUndefined();
    expect(state.entities.snapshots[summary.id]).toBeUndefined();
  });

  it('状态变更同步 summary 与快照', () => {
    const summary = makeSummary();
    const snapshot = makeSnapshot({ thread: summary, seq: 0 });
    let state = stateWith(snapshot);
    state = notify(state, {
      method: 'thread/status/changed',
      params: {
        threadId: summary.id,
        seq: 1,
        status: 'awaitingApproval',
        activeFlags: [],
      },
    });
    expect(state.entities.threads[summary.id]?.status).toBe('awaitingApproval');
    expect(state.entities.snapshots[summary.id]?.thread.status).toBe(
      'awaitingApproval',
    );
  });

  it('thread/archived 只设置归档事实，不改写最后运行状态', () => {
    const summary = makeSummary({ status: 'interrupted' });
    let state = stateWith(makeSnapshot({ thread: summary, seq: 0 }));

    state = notify(state, {
      method: 'thread/archived',
      params: { threadId: summary.id, seq: 1 },
    });

    expect(state.entities.threads[summary.id]).toMatchObject({
      archived: true,
      status: 'interrupted',
    });
    expect(state.entities.snapshots[summary.id]?.thread).toMatchObject({
      archived: true,
      status: 'interrupted',
    });
  });

  it('thread/unarchived 使用 Server summary 恢复归档事实并保留运行状态', () => {
    const archived = makeSummary({ archived: true, status: 'failed' });
    let state = stateWith(makeSnapshot({ thread: archived, seq: 4 }));
    const unarchived = { ...archived, archived: false };

    state = notify(state, {
      method: 'thread/unarchived',
      params: {
        threadId: archived.id,
        seq: 5,
        thread: unarchived,
      },
    });

    expect(state.entities.threads[archived.id]).toMatchObject({
      archived: false,
      status: 'failed',
    });
    expect(state.entities.snapshots[archived.id]?.thread).toMatchObject({
      archived: false,
      status: 'failed',
    });
  });
});
