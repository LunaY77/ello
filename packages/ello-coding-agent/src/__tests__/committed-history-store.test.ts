import { describe, expect, it } from 'vitest';

import {
  appendCommittedHistory,
  emptyCommittedHistory,
  replaceCommittedHistory,
} from '../tui/store/committed-history-store.js';

describe('committed-history-store', () => {
  it('appends immutable history entries', () => {
    const first = appendCommittedHistory(emptyCommittedHistory, {
      kind: 'user',
      id: 'u1',
      text: 'hello',
    });
    const second = appendCommittedHistory(first, {
      kind: 'assistant',
      id: 'a1',
      text: 'hi',
    });

    expect(emptyCommittedHistory.entries).toHaveLength(0);
    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(2);
  });

  it('dedupes adjacent optimistic user input', () => {
    const first = appendCommittedHistory(emptyCommittedHistory, {
      kind: 'user',
      id: 'u1',
      text: 'hello',
    });
    const second = appendCommittedHistory(first, {
      kind: 'user',
      id: 'u2',
      text: 'hello',
    });

    expect(second.entries).toHaveLength(1);
  });

  it('replaces restored history as source of truth', () => {
    const state = replaceCommittedHistory([
      { kind: 'user', id: 'u1', text: 'restored' },
    ]);

    expect(state.entries).toEqual([
      { kind: 'user', id: 'u1', text: 'restored' },
    ]);
  });
});
