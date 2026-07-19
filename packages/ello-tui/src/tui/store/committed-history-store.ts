import type { HistoryEntry } from './history-entry.js';

export interface CommittedHistoryState {
  readonly entries: readonly HistoryEntry[];
}

export const emptyCommittedHistory: CommittedHistoryState = {
  entries: [],
};

export function replaceCommittedHistory(
  entries: readonly HistoryEntry[],
): CommittedHistoryState {
  return { entries: [...entries] };
}

export function appendCommittedHistory(
  state: CommittedHistoryState,
  entry: HistoryEntry,
): CommittedHistoryState {
  const last = state.entries.at(-1);
  if (
    entry.kind === 'user' &&
    last?.kind === 'user' &&
    last.text === entry.text
  ) {
    return state;
  }
  return { entries: [...state.entries, entry] };
}
