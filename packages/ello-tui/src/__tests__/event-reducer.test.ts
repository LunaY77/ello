import { describe, expect, it } from 'vitest';

import type {
  ServerNotification,
  ThreadSnapshot,
} from '../api/protocol-types.js';
import { reduceNotification } from '../client/event-reducer.js';

const createdAt = '2026-07-18T00:00:00.000Z';

describe('thread notification reducer', () => {
  it('内部记录通过 sequence notification 连续推进公开 seq', () => {
    const advanced = reduceNotification(
      { snapshot: fixtureSnapshot(), stale: false },
      notification('thread/sequence/advanced', 2, {}),
    );

    expect(advanced.gap).toBeUndefined();
    expect(advanced.projection).toMatchObject({
      stale: false,
      snapshot: { seq: 2, turns: [] },
    });
  });

  it('按 seq 幂等处理 item lifecycle，并在 gap 时标记 stale', () => {
    const started = reduceNotification(
      { snapshot: fixtureSnapshot(), stale: false },
      notification('turn/started', 2, {
        turnId: 'turn_1',
        turn: {
          id: 'turn_1',
          threadId: 'thr_1',
          status: 'inProgress',
          items: [],
          startedAt: createdAt,
        },
      }),
    );
    expect(started.projection.snapshot.turns).toHaveLength(1);

    const duplicate = reduceNotification(
      started.projection,
      notification('turn/started', 2, {
        turnId: 'turn_1',
        turn: started.projection.snapshot.turns[0]!,
      }),
    );
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.projection).toBe(started.projection);

    const item = {
      id: 'item_1',
      turnId: 'turn_1',
      type: 'agentMessage' as const,
      text: '',
      phase: 'commentary' as const,
      status: 'inProgress' as const,
      createdAt,
    };
    const gap = reduceNotification(
      started.projection,
      notification('item/started', 4, {
        turnId: 'turn_1',
        itemId: item.id,
        item,
      }),
    );
    expect(gap.gap).toEqual({ expectedSeq: 3, receivedSeq: 4 });
    expect(gap.projection.stale).toBe(true);

    const delta = reduceNotification(
      gap.projection,
      notification('item/agentMessage/delta', 5, {
        turnId: 'turn_1',
        itemId: item.id,
        delta: 'hello',
      }),
    );
    expect(delta.projection.snapshot.turns[0]?.items[0]).toMatchObject({
      text: 'hello',
    });

    const completed = reduceNotification(
      delta.projection,
      notification('item/completed', 6, {
        turnId: 'turn_1',
        itemId: item.id,
        item: { ...item, text: 'hello world', status: 'completed' },
      }),
    );
    expect(completed.projection.snapshot.turns[0]?.items[0]).toMatchObject({
      text: 'hello world',
      status: 'completed',
    });
  });
});

function fixtureSnapshot(): ThreadSnapshot {
  return {
    thread: {
      id: 'thr_1',
      rootId: 'thr_1',
      cwd: '/workspace',
      name: '',
      preview: '',
      status: 'idle',
      archived: false,
      createdAt,
      updatedAt: createdAt,
    },
    settings: {
      mode: 'ask-before-changes',
      profile: 'main',
      model: 'mock/model',
      agent: 'build',
    },
    turns: [],
    pendingServerRequests: [],
    goal: null,
    plan: null,
    usage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
    },
    seq: 1,
  };
}

function notification<M extends ServerNotification['method']>(
  method: M,
  seq: number,
  params: Omit<
    Extract<ServerNotification, { method: M }>['params'],
    'threadId' | 'seq'
  >,
): Extract<ServerNotification, { method: M }> {
  return { method, params: { threadId: 'thr_1', seq, ...params } } as Extract<
    ServerNotification,
    { method: M }
  >;
}
