import { Static } from 'ink';

import type { HistoryEntry } from '../store/history-entry.js';
import { HistoryEntryRenderer } from '../store/HistoryRenderer.js';

export function TerminalHistoryOutput({
  entries,
  resetKey,
  cwd,
  settings,
}: {
  readonly entries: readonly HistoryEntry[];
  readonly resetKey: number;
  readonly cwd: string;
  readonly settings: {
    readonly profile: string;
    readonly model: string;
    readonly mode: string;
  };
}) {
  const displayedEntries = entries.map((entry) =>
    entry.kind === 'session_header' ? { ...entry, ...settings } : entry,
  );
  return (
    <Static key={resetKey} items={displayedEntries}>
      {(entry) => (
        <HistoryEntryRenderer key={entry.id} entry={entry} cwd={cwd} />
      )}
    </Static>
  );
}
