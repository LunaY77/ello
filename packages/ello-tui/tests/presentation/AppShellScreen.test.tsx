import { Box, Static, Text } from 'ink';
import { describe, expect, it } from 'vitest';

import { AppShell } from '../../src/tui/component/AppShell.js';
import type {
  SubagentRunView,
  ToolCallView,
} from '../../src/tui/store/history-entry.js';
import {
  dockFitsTerminal,
  OVERLAY_MAX_ROWS,
} from '../../src/tui/store/live-budget.js';
import { mountTerminal } from '../support/terminal-harness.js';

/**
 * 屏幕级回归：断言用户真正看到的画面，而不是输出字节里包含什么。
 *
 * 保护两件事：
 * 1. dynamic frame 永远矮于终端高度 —— 否则 Ink 每帧 `clearTerminal` + 重写整个
 *    Static 历史，就是 TUI 上的闪屏；
 * 2. 内容超预算时靠 live 区自己截断 —— 给 Box 设固定 height 会被 Ink 压扁成非连续
 *    的行，把 composer 边框和 footer 撕碎。
 */

const HISTORY = Array.from(
  { length: 6 },
  (_, index) => `history line ${index}`,
);

/** Ink 整屏重绘的标记。 */
const CLEAR_TERMINAL = '\u001B[2J';

function runningTool(index: number): ToolCallView {
  return {
    id: `tool-${index}`,
    name: 'bash',
    input: { command: `sleep ${index}` },
    status: 'running',
  };
}

function runningSubagent(index: number): SubagentRunView {
  return {
    runId: `run-${index}`,
    agentName: `agent-${index}`,
    description: `task ${index}`,
    status: 'running',
    background: false,
    startedAt: '2026-08-08T00:00:00.000Z',
    tools: [],
  };
}

interface Scenario {
  readonly name: string;
  readonly props: Partial<Parameters<typeof AppShell>[0]>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: '长 reasoning 流',
    props: {
      liveReasoningText: Array.from(
        { length: 400 },
        (_, index) => `reasoning line ${index}`,
      ).join('\n'),
    },
  },
  {
    name: '长 assistant 流',
    props: {
      liveAssistantText: Array.from(
        { length: 300 },
        (_, index) => `assistant line ${index}`,
      ).join('\n'),
    },
  },
  {
    name: '大量并行工具',
    props: {
      runningTools: Array.from({ length: 20 }, (_, index) =>
        runningTool(index),
      ),
    },
  },
  {
    name: '大量并行 subagent',
    props: {
      runningSubagents: Array.from({ length: 12 }, (_, index) =>
        runningSubagent(index),
      ),
    },
  },
  {
    name: '大量排队 steer',
    props: {
      pendingSteers: Array.from({ length: 30 }, (_, index) => `steer ${index}`),
    },
  },
  {
    name: '全部同时发生',
    props: {
      liveReasoningText: Array.from(
        { length: 200 },
        (_, index) => `reasoning ${index}`,
      ).join('\n'),
      liveAssistantText: Array.from(
        { length: 200 },
        (_, index) => `assistant ${index}`,
      ).join('\n'),
      liveCompactionText: 'Compacting context…',
      runningTools: Array.from({ length: 10 }, (_, index) =>
        runningTool(index),
      ),
      runningSubagents: Array.from({ length: 6 }, (_, index) =>
        runningSubagent(index),
      ),
      pendingSteers: Array.from({ length: 10 }, (_, index) => `steer ${index}`),
    },
  },
  {
    name: 'overlay 打开且有 agent 列表',
    props: {
      liveReasoningText: Array.from(
        { length: 200 },
        (_, index) => `reasoning ${index}`,
      ).join('\n'),
      overlayOpen: true,
      agentRows: 6,
      composerRows: 4,
      // overlay 的行数上界由 InlineSelect 的固定窗口决定，见 OVERLAY_MAX_ROWS。
      overlay: (
        <Box flexDirection="column">
          {Array.from({ length: OVERLAY_MAX_ROWS }, (_, index) => (
            <Text key={index}>{`overlay row ${index}`}</Text>
          ))}
        </Box>
      ),
    },
  },
];

const SIZES = [
  { columns: 40, rows: 20 },
  { columns: 60, rows: 24 },
  { columns: 80, rows: 24 },
  { columns: 80, rows: 12 },
  { columns: 120, rows: 40 },
] as const;

/** 与真实 App 一致的长 model 串：窄终端上换行就会顶高 frame。 */
const MODEL =
  'primary: deepseek/deepseek-v4-pro · auxiliary: deepseek/deepseek-v4-flash';

/**
 * dock 必须真的花掉它声明的行数，否则测不出预算算漏的情况。
 * `composerRows` 既传给 AppShell 做预算，也决定这里实际渲染多少行。
 */
function dockComposer(composerRows: number) {
  return (
    <Box flexDirection="column" width="100%">
      <Text>{'> composer text'}</Text>
      {Array.from({ length: Math.max(0, composerRows - 1) }, (_, index) => (
        <Text key={index}>{`composer extra ${index}`}</Text>
      ))}
    </Box>
  );
}

function shell(overrides: Partial<Parameters<typeof AppShell>[0]>) {
  const composerRows = overrides.composerRows ?? 2;
  const agentRows = overrides.agentRows ?? 0;
  return (
    <>
      <Static items={HISTORY}>
        {(line) => <Text key={line}>{line}</Text>}
      </Static>
      <AppShell
        cwd="/workspace"
        model={MODEL}
        mode={{ mode: 'ask-before-changes' }}
        liveAssistantText=""
        runningTools={[]}
        runningSubagents={[]}
        running
        workingSeconds={7}
        overlay={null}
        {...overrides}
        composerRows={composerRows}
        agentRows={agentRows}
        composer={dockComposer(composerRows)}
        {...(agentRows === 0
          ? {}
          : {
              agentSwitcher: (
                <>
                  {Array.from({ length: agentRows }, (_, index) => (
                    <Text key={index}>{`agent row ${index}`}</Text>
                  ))}
                </>
              ),
            })}
      />
    </>
  );
}

describe('AppShell 屏幕布局', () => {
  for (const size of SIZES) {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name} 在 ${size.columns}x${size.rows} 下保持 dock 完整且不整屏重绘`, async () => {
        const harness = await mountTerminal(shell(scenario.props), size);
        try {
          const start = harness.writes.length;
          await harness.rerender(
            shell({ ...scenario.props, workingSeconds: 8 }),
          );
          const streamed = harness.writes.slice(start).join('');
          // Ink 只在 frame 高度达到终端高度时才发 clearTerminal。dock 本身就装不下的
          // 终端（很矮 + overlay + 多 child）是显式承认的降级，只要求 dock 不被撕碎。
          const fits = dockFitsTerminal(size.rows, {
            composerRows: scenario.props.composerRows ?? 2,
            agentRows: scenario.props.agentRows ?? 0,
            overlayOpen: scenario.props.overlayOpen ?? false,
          });
          const lines = harness.screen.lines();
          const screen = lines.join('\n');

          if (!fits) {
            // 28 行 dock 放不进 12 行终端：只要求 footer 没被压扁成互相覆盖的行。
            expect(screen).toContain('ask-before-changes');
            expect(screen).toContain('cache');
            return;
          }

          expect(streamed).not.toContain(CLEAR_TERMINAL);

          const composerRow = lines.findIndex((line) =>
            line.includes('composer text'),
          );
          // composer 必须完整可见，且被自己的单边框上下包住。
          expect(composerRow).toBeGreaterThan(0);
          expect(lines[composerRow - 1]).toContain('┌');

          // footer 三行不得互相覆盖，也不得被挤出屏幕。
          const below = lines.slice(composerRow).join('\n');
          expect(below).toContain('└');
          expect(below).toContain('ask-before-changes');
          expect(below).toContain('cache');
        } finally {
          harness.stop();
        }
      });
    }
  }

  it('流式更新期间不触发整屏重绘，历史留在屏幕上', async () => {
    const reasoning = (count: number) =>
      Array.from({ length: count }, (_, index) => `reasoning ${index}`).join(
        '\n',
      );
    const harness = await mountTerminal(
      shell({ liveReasoningText: reasoning(200) }),
      { columns: 80, rows: 24 },
    );
    try {
      const start = harness.writes.length;
      for (let tick = 1; tick <= 5; tick += 1) {
        await harness.rerender(
          shell({ liveReasoningText: reasoning(200 + tick) }),
        );
      }
      const streamed = harness.writes.slice(start).join('');

      // Ink 的整屏重绘会带上 clearTerminal 与整份 Static 历史。
      expect(streamed).not.toContain(CLEAR_TERMINAL);
      expect(streamed).not.toContain('history line 0');

      // 历史仍然留在可视区域，没有被 live 区顶出屏幕。
      expect(harness.screen.lines()).toContain('history line 0');
      expect(harness.screen.scrollback).toEqual([]);
    } finally {
      harness.stop();
    }
  });

  it('reasoning 只占一行尾部预览', async () => {
    const harness = await mountTerminal(
      shell({
        liveReasoningText: Array.from(
          { length: 50 },
          (_, index) => `reasoning ${index}`,
        ).join('\n'),
      }),
      { columns: 80, rows: 24 },
    );
    try {
      const thinking = harness.screen
        .lines()
        .filter((line) => line.includes('Thinking:'));
      expect(thinking).toHaveLength(1);
      expect(thinking[0]).toContain('reasoning 49');
    } finally {
      harness.stop();
    }
  });
});
