import { describe, expect, it } from 'vitest';

import {
  allocateLiveRows,
  dockFitsTerminal,
  dockRows,
  liveViewportRows,
  SUBAGENT_ROWS,
  TOOL_CARD_ROWS,
} from '../../src/tui/store/live-budget.js';
import { tailVisualRows } from '../../src/tui/store/terminal-text.js';

const IDLE = { composerRows: 1, agentRows: 0, overlayOpen: false } as const;

describe('liveViewportRows', () => {
  it('给 live 区留下终端高度减 dock 再减 1 行', () => {
    // 少扣的那 1 行是关键：Ink 在 outputHeight >= rows 时就整屏重绘。
    expect(liveViewportRows(24, IDLE)).toBe(24 - dockRows(IDLE) - 1);
  });

  it('dock 装不下时 live 区让到 0 行', () => {
    // 硬留几行只会把 frame 顶过终端高度，反而触发 Ink 整屏重绘。
    expect(liveViewportRows(8, IDLE)).toBe(0);
    expect(liveViewportRows(1, IDLE)).toBe(0);
    expect(dockFitsTerminal(7, IDLE)).toBe(false);
    expect(dockFitsTerminal(8, IDLE)).toBe(true);
    expect(dockFitsTerminal(24, IDLE)).toBe(true);
  });

  it('dock 装得下时 frame 一定矮于终端高度', () => {
    // 这是整个修复的核心不变量：frame < rows，Ink 才不会整屏重绘。
    for (const rows of [12, 20, 24, 40, 60]) {
      for (const cost of [
        IDLE,
        { ...IDLE, composerRows: 5 },
        { ...IDLE, agentRows: 8 },
        { ...IDLE, overlayOpen: true },
      ]) {
        if (!dockFitsTerminal(rows, cost)) continue;
        expect(
          liveViewportRows(rows, cost) + dockRows(cost),
        ).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('overlay、agent 列表和多行 composer 都会压缩 live 区', () => {
    const base = liveViewportRows(40, IDLE);
    expect(liveViewportRows(40, { ...IDLE, overlayOpen: true })).toBeLessThan(
      base,
    );
    expect(liveViewportRows(40, { ...IDLE, agentRows: 5 })).toBe(base - 5);
    expect(liveViewportRows(40, { ...IDLE, composerRows: 4 })).toBe(base - 3);
  });
});

describe('allocateLiveRows', () => {
  const empty = {
    hasCompaction: false,
    hasReasoning: false,
    hasAssistant: false,
    toolCount: 0,
    commandRunCount: 0,
    subagentCount: 0,
    steerCount: 0,
    statusRows: 2,
  } as const;

  it('分配总量不超过预算', () => {
    const maxRows = 12;
    const budget = allocateLiveRows({
      ...empty,
      maxRows,
      hasCompaction: true,
      hasReasoning: true,
      hasAssistant: true,
      toolCount: 8,
      subagentCount: 4,
      steerCount: 6,
    });
    const used =
      empty.statusRows +
      budget.compactionRows +
      budget.reasoningRows +
      budget.assistantRows +
      budget.toolCount * TOOL_CARD_ROWS +
      budget.subagentCount * SUBAGENT_ROWS +
      (budget.steerCount === 0 ? 0 : budget.steerCount + 2);
    expect(used).toBeLessThanOrEqual(maxRows);
  });

  it('工具很多时仍给 assistant 留下可读的最小行数', () => {
    const budget = allocateLiveRows({
      ...empty,
      maxRows: 16,
      hasAssistant: true,
      toolCount: 20,
    });
    expect(budget.assistantRows).toBeGreaterThanOrEqual(3);
  });

  it('预算耗尽时先丢卡片而不是丢运行状态', () => {
    const budget = allocateLiveRows({
      ...empty,
      maxRows: 3,
      hasReasoning: true,
      toolCount: 5,
      subagentCount: 5,
    });
    expect(budget.reasoningRows).toBe(1);
    expect(budget.toolCount).toBe(0);
    expect(budget.subagentCount).toBe(0);
  });

  it('放不下 steer 标题就整段不显示，避免只剩一个孤立标题', () => {
    const budget = allocateLiveRows({
      ...empty,
      maxRows: 3,
      steerCount: 4,
    });
    expect(budget.steerCount).toBe(0);
  });
});

describe('tailVisualRows', () => {
  it('按视觉行取尾部', () => {
    expect(tailVisualRows('a\nb\nc\nd', 10, 2)).toEqual(['c', 'd']);
  });

  it('软换行也算作视觉行', () => {
    expect(tailVisualRows('abcdefgh', 3, 2)).toEqual(['def', 'gh']);
  });

  it('全角字符按终端列宽计算，不按字符数', () => {
    // 每个汉字占 2 列，宽度 4 => 每行 2 个字。
    expect(tailVisualRows('中文测试', 4, 1)).toEqual(['测试']);
  });

  it('不拆开 emoji', () => {
    expect(tailVisualRows('👍👍👍', 4, 2)).toEqual(['👍👍', '👍']);
  });

  it('文本刚好占满一行时不补出停放光标的空行', () => {
    // layoutTerminalText 会为 Composer 光标保留一个空视觉行，预览不能继承这个语义。
    expect(tailVisualRows('中文测试', 4, 3)).toEqual(['中文', '测试']);
  });

  it('maxRows 为 0 或文本为空时返回空', () => {
    expect(tailVisualRows('abc', 10, 0)).toEqual([]);
    expect(tailVisualRows('', 10, 3)).toEqual([]);
  });
});
