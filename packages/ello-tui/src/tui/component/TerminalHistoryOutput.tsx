import { Static } from 'ink';
import { memo, useEffect, useState } from 'react';

import type { HistoryEntry } from '../store/history-entry.js';
import { HistoryEntryRenderer } from '../store/HistoryRenderer.js';

/**
 * 一次 Ink 渲染最多新增的历史条目数。
 *
 * 单条历史条目的 Ink 渲染开销可达数十毫秒，resume 一个大 Thread 会一次性回放上百条：
 * 实测 160 条一次渲染阻塞事件循环 1.6s，期间 App Server 连接得不到读取，慢到会被
 * 连接层的背压预算判成对端卡死。分批回放后总耗时不变，但单次阻塞降到百毫秒级。
 */
const HISTORY_REPLAY_BATCH = 4;

/** Static 历史区域只在提交条目或 reset key 改变时重新渲染。 */
export const TerminalHistoryOutput = memo(function TerminalHistoryOutput({
  entries,
  resetKey,
  cwd,
  settings,
}: {
  readonly entries: readonly HistoryEntry[];
  readonly resetKey: number;
  readonly cwd: string;
  readonly settings: {
    readonly agent: string;
    readonly mode: string;
  };
}) {
  const [replay, setReplay] = useState({
    resetKey,
    revealed: HISTORY_REPLAY_BATCH,
  });
  // reset key 变化会重挂 Static 并重放全部历史，回放进度必须跟着回到起点。
  if (replay.resetKey !== resetKey) {
    setReplay({ resetKey, revealed: HISTORY_REPLAY_BATCH });
  }

  const revealed = Math.min(replay.revealed, entries.length);
  const backlog = entries.length - revealed;
  useEffect(() => {
    if (backlog <= 0) return;
    const timer = setTimeout(() => {
      setReplay((current) => ({
        ...current,
        revealed: current.revealed + HISTORY_REPLAY_BATCH,
      }));
    }, 0);
    return () => clearTimeout(timer);
  }, [backlog]);

  // 只有明显落后（resume 回放）才分批；正常追加一条时直接渲染，不给流式输出加一帧延迟。
  const visibleEntries =
    backlog > HISTORY_REPLAY_BATCH ? entries.slice(0, revealed) : entries;
  const displayedEntries = visibleEntries.map((entry) =>
    entry.kind === 'session_header' ? { ...entry, ...settings } : entry,
  );
  return (
    <Static key={resetKey} items={displayedEntries}>
      {(entry) => (
        <HistoryEntryRenderer key={entry.id} entry={entry} cwd={cwd} />
      )}
    </Static>
  );
});
