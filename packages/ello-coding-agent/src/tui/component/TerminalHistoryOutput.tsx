import { Static } from 'ink';

import type { HistoryEntry } from '../store/history-entry.js';
import { HistoryEntryRenderer } from '../store/HistoryRenderer.js';

export function TerminalHistoryOutput({
  entries,
  resetKey,
  cwd,
}: {
  readonly entries: readonly HistoryEntry[];
  readonly resetKey: number;
  readonly cwd: string;
}) {
  return (
    <Static key={resetKey} items={[...entries]}>
      {(entry) => <HistoryEntryRenderer entry={entry} cwd={cwd} />}
    </Static>
  );
}
