import { Box, Text } from 'ink';
import { describe, expect, it } from 'vitest';

import {
  Composer,
  composerRowCount,
  composerTextWidthForTerminal,
} from '../../src/tui/component/Composer.js';
import { mountTerminal } from '../support/terminal-harness.js';

/**
 * `composerRowCount()` 是 live 区行数预算的输入之一。它一旦少算一行，dynamic frame 就会
 * 顶到终端高度，Ink 会每帧 `clearTerminal` + 重写整个会话历史（闪屏）。
 *
 * 所以这里断言预测值等于 Composer 真实渲染出的行数，而不是各自独立演进。
 */

const COLUMNS = 100;
const TOP = '<<<top>>>';
const BOTTOM = '<<<bottom>>>';

interface Case {
  readonly name: string;
  readonly value: string;
  readonly running: boolean;
  readonly suggestionCount: number;
  readonly target?: string;
}

const CASES: readonly Case[] = [
  { name: '空闲单行', value: '', running: false, suggestionCount: 0 },
  {
    name: '运行中多出 steer 提示',
    value: '',
    running: true,
    suggestionCount: 0,
  },
  { name: '带补全候选', value: '/mo', running: false, suggestionCount: 3 },
  {
    name: '候选超过窗口上限',
    value: '/',
    running: false,
    suggestionCount: 20,
  },
  {
    name: '运行中且有候选',
    value: '/mo',
    running: true,
    suggestionCount: 4,
  },
  {
    name: '查看 child 时的 steer 目标行',
    value: '',
    running: true,
    suggestionCount: 0,
    target: 'reviewer',
  },
  {
    name: '多行输入',
    value: 'line one\nline two\nline three',
    running: false,
    suggestionCount: 0,
  },
  {
    name: '软换行的长输入',
    value: 'x'.repeat(250),
    running: false,
    suggestionCount: 0,
  },
];

async function measure(testCase: Case): Promise<number> {
  const textWidth = composerTextWidthForTerminal(COLUMNS);
  const harness = await mountTerminal(
    <Box flexDirection="column">
      <Text>{TOP}</Text>
      <Composer
        isActive={false}
        running={testCase.running}
        history={[]}
        value={testCase.value}
        textWidth={textWidth}
        {...(testCase.suggestionCount > 0
          ? {
              suggestions: Array.from(
                { length: testCase.suggestionCount },
                (_, index) => `/cmd${index}`,
              ),
            }
          : {})}
        {...(testCase.target === undefined ? {} : { target: testCase.target })}
        onChange={() => undefined}
        onSuggestionAccepted={() => undefined}
        onSubmit={() => undefined}
        onCancel={() => undefined}
        onEscape={() => undefined}
        onMovePastEnd={() => false}
      />
      <Text>{BOTTOM}</Text>
    </Box>,
    { columns: COLUMNS, rows: 60 },
  );
  try {
    const lines = harness.screen.lines();
    const top = lines.findIndex((line) => line.includes(TOP));
    const bottom = lines.findIndex((line) => line.includes(BOTTOM));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeGreaterThan(top);
    return bottom - top - 1;
  } finally {
    harness.stop();
  }
}

describe('composerRowCount', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} 的预测行数与真实渲染一致`, async () => {
      const textWidth = composerTextWidthForTerminal(COLUMNS);
      const actual = await measure(testCase);
      const predicted = composerRowCount({
        textRows: visualRowCount(testCase.value, textWidth),
        running: testCase.running,
        hasSteerTarget: testCase.target !== undefined,
        suggestionCount: testCase.suggestionCount,
      });
      expect(predicted).toBe(actual);
    });
  }
});

/** Composer 用视觉行排版，行数要按终端列宽算，不能按 `\n` 数。 */
function visualRowCount(value: string, width: number): number {
  return value
    .split('\n')
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / width)),
      0,
    );
}
