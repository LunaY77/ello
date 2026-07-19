import { describe, expect, it } from 'vitest';

import {
  appendCommittedHistory,
  emptyCommittedHistory,
  replaceCommittedHistory,
} from '../../src/tui/store/committed-history-store.js';
import type { HistoryEntry } from '../../src/tui/store/history-entry.js';

function user(id: string, text: string): HistoryEntry {
  return { kind: 'user', id, turnId: `turn-${id}`, text };
}

describe('已提交历史记录', () => {
  it('按提交顺序追加记录且不修改已有状态', () => {
    const first = appendCommittedHistory(
      emptyCommittedHistory,
      user('u1', 'hello'),
    );
    const second = appendCommittedHistory(first, {
      kind: 'assistant',
      id: 'a1',
      text: 'hi',
    });

    expect(emptyCommittedHistory.entries).toEqual([]);
    expect(first.entries).toEqual([user('u1', 'hello')]);
    expect(second.entries.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('去重相邻且文本相同的乐观用户消息', () => {
    const first = appendCommittedHistory(
      emptyCommittedHistory,
      user('u1', 'hello'),
    );
    const duplicate = appendCommittedHistory(first, user('u2', 'hello'));

    expect(duplicate.entries).toEqual([user('u1', 'hello')]);
  });

  it('不会去重文本不同或被其它消息隔开的用户消息', () => {
    let state = appendCommittedHistory(
      emptyCommittedHistory,
      user('u1', 'hello'),
    );
    state = appendCommittedHistory(state, {
      kind: 'assistant',
      id: 'a1',
      text: 'reply',
    });
    state = appendCommittedHistory(state, user('u2', 'hello'));
    state = appendCommittedHistory(state, user('u3', 'different'));

    expect(state.entries).toHaveLength(4);
  });

  it('用恢复结果替换本地历史，并复制调用方数组', () => {
    const restored: HistoryEntry[] = [user('u1', 'restored')];
    const state = replaceCommittedHistory(restored);
    restored.push(user('u2', 'later mutation'));

    expect(state.entries).toEqual([user('u1', 'restored')]);
  });
});
