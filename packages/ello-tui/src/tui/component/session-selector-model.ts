import type { ThreadSummary } from '../../api/protocol-types.js';

export type SessionSelectorFocus = 'search' | 'cwd' | 'sort' | 'list';
export type SessionCwdFilter = 'all' | 'current';
export type SessionSortOrder = 'updated' | 'created';

export function selectSessions(
  sessions: readonly ThreadSummary[],
  query: string,
  cwdFilter: SessionCwdFilter,
  currentCwd: string,
  sortOrder: SessionSortOrder,
): readonly ThreadSummary[] {
  const normalized = query.trim().toLowerCase();
  const terms = normalized === '' ? [] : normalized.split(/\s+/u);
  return sessions
    .filter((session) => cwdFilter === 'all' || session.cwd === currentCwd)
    .filter((session) => {
      const haystack = [session.id, session.name, session.preview, session.cwd]
        .join(' ')
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .toSorted((left, right) => {
      const leftTime =
        sortOrder === 'updated' ? left.updatedAt : left.createdAt;
      const rightTime =
        sortOrder === 'updated' ? right.updatedAt : right.createdAt;
      return (
        rightTime.localeCompare(leftTime) || right.id.localeCompare(left.id)
      );
    });
}

export function cycleSessionSelectorFocus(
  current: SessionSelectorFocus,
  reverse: boolean,
): SessionSelectorFocus {
  const order: readonly SessionSelectorFocus[] = [
    'search',
    'cwd',
    'sort',
    'list',
  ];
  const currentIndex = order.indexOf(current);
  const nextIndex = reverse
    ? (currentIndex - 1 + order.length) % order.length
    : (currentIndex + 1) % order.length;
  const next = order[nextIndex];
  if (next === undefined) {
    throw new Error(`Invalid selector focus index ${nextIndex}.`);
  }
  return next;
}
