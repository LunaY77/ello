/**
 * 本文件验证历史区域把大批回放拆成多帧、而正常追加仍然单帧完成。
 *
 * 断言基于真实写入终端的字节：单帧一次性渲染上百条会阻塞事件循环到秒级，
 * 那正是 resume 大 session 时连接被判成卡死的原因。
 */
import { describe, expect, it } from 'vitest';

import { TerminalHistoryOutput } from '../../src/tui/component/TerminalHistoryOutput.js';
import type { HistoryEntry } from '../../src/tui/store/history-entry.js';
import { mountTerminal } from '../support/terminal-harness.js';

const settings = { agent: 'build', mode: 'ask-before-changes' } as const;

describe('TerminalHistoryOutput 回放节奏', () => {
  it('大批历史分帧回放，不在单帧里写完全部条目', async () => {
    const entries = diagnostics(24);
    const harness = await mountTerminal(view(entries), {
      columns: 80,
      rows: 200,
    });

    try {
      await harness.flush();
      const framesWithEntries = harness.writes.filter((write) =>
        ENTRY_PATTERN.test(write),
      );
      expect(framesWithEntries.length).toBeGreaterThan(1);
      expect(framesWithEntries[0]).toContain('entry-01');
      expect(framesWithEntries[0]).not.toContain('entry-24');

      const everything = harness.writes.join('');
      for (const entry of entries) {
        expect(everything).toContain(entry.text);
      }
    } finally {
      harness.stop();
    }
  });

  it('追加单条历史只写一帧，不因分帧多等一轮', async () => {
    const entries = diagnostics(24);
    const harness = await mountTerminal(view(entries), {
      columns: 80,
      rows: 200,
    });

    try {
      await harness.flush();
      const before = harness.writes.length;

      const appended: HistoryEntry = {
        kind: 'diagnostic',
        id: 'appended',
        text: 'entry-appended',
      };
      await harness.rerender(view([...entries, appended]));

      const appendedFrames = harness.writes
        .slice(before)
        .filter((write) => ENTRY_PATTERN.test(write));
      expect(appendedFrames).toHaveLength(1);
      expect(appendedFrames[0]).toContain('entry-appended');
    } finally {
      harness.stop();
    }
  });
});

const ENTRY_PATTERN = /entry-/;

function view(entries: readonly HistoryEntry[]) {
  return (
    <TerminalHistoryOutput
      entries={entries}
      resetKey={0}
      cwd="/workspace"
      settings={settings}
    />
  );
}

function diagnostics(
  count: number,
): ReadonlyArray<Extract<HistoryEntry, { readonly kind: 'diagnostic' }>> {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: 'diagnostic' as const,
    id: `diagnostic-${index + 1}`,
    text: `entry-${String(index + 1).padStart(2, '0')}`,
  }));
}
