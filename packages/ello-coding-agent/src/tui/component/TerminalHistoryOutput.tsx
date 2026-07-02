import { Static } from 'ink';

import type { HistoryEntry } from '../store/history-entry.js';
import { renderHistoryEntry } from '../store/HistoryRenderer.js';

export function TerminalHistoryOutput({
  entries,
  resetKey,
}: {
  readonly entries: readonly HistoryEntry[];
  readonly resetKey: number;
}) {
  return (
    <Static key={resetKey} items={[...entries]}>
      {(entry) => renderHistoryEntry(entry)}
    </Static>
  );
}
