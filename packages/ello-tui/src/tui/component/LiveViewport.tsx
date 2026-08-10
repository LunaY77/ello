import { Box, Text } from 'ink';
import { memo } from 'react';

import type {
  CommandRunView,
  SubagentRunView,
  ToolCallView,
} from '../store/history-entry.js';
import { CommandRunGroup } from '../store/HistoryRenderer.js';
import { allocateLiveRows, MIN_LIVE_ROWS } from '../store/live-budget.js';
import { tailVisualRows } from '../store/terminal-text.js';
import { useTheme } from '../theme/index.js';
import { glyphs } from '../ui/glyphs.js';

import { SubagentActivity } from './SubagentActivity.js';
import { ToolActivityList } from './ToolActivityList.js';

/** reasoning 按设计稿 §5 折叠为单行尾部预览，完整内容只进静态历史。 */
const REASONING_PREVIEW_PREFIX = 'Thinking: ';

/**
 * live 区只接收当前增量状态；已提交历史由 TerminalHistoryOutput 冻结。
 *
 * 这里必须自己把输出压进 `maxRows`：Ink 一旦发现 dynamic frame 达到终端高度，就会
 * 每帧 `clearTerminal` + 重写整个会话历史，也就是闪屏的来源。详见
 * `store/live-budget.ts`。
 */
export const LiveViewport = memo(function LiveViewport({
  cwd,
  assistantText,
  reasoningText,
  compactionText,
  runningTools,
  runningCommandRuns,
  runningSubagents,
  running,
  maxRows = MIN_LIVE_ROWS,
  textWidth = 80,
  workingSeconds,
  interruptNotice,
  pendingSteers = [],
}: {
  readonly cwd: string;
  readonly assistantText: string;
  readonly reasoningText: string;
  readonly compactionText: string;
  readonly runningTools: readonly ToolCallView[];
  readonly runningCommandRuns: readonly CommandRunView[];
  readonly runningSubagents: readonly SubagentRunView[];
  readonly running: boolean;
  /** live 区可用终端行数，由 AppShell 依据终端高度和 dock 开销计算。 */
  readonly maxRows?: number;
  /** live 区可用列宽，用于把文本按视觉行截断。 */
  readonly textWidth?: number;
  readonly workingSeconds?: number;
  readonly interruptNotice?: string;
  readonly pendingSteers?: readonly string[];
}) {
  const visibleAssistantText = assistantText.trim();
  const visibleReasoningText = reasoningText.trim();
  const visibleCompactionText = compactionText.trim();
  const statusRows = running || interruptNotice !== undefined ? 2 : 0;

  const budget = allocateLiveRows({
    maxRows,
    hasCompaction: visibleCompactionText !== '',
    hasReasoning: visibleReasoningText !== '',
    hasAssistant: visibleAssistantText !== '',
    toolCount: runningTools.length,
    commandRunCount: runningCommandRuns.length,
    subagentCount: runningSubagents.length,
    steerCount: pendingSteers.length,
    statusRows,
  });

  const assistantLines = tailVisualRows(
    visibleAssistantText,
    Math.max(1, textWidth - 2),
    budget.assistantRows,
  );
  const reasoningPreview =
    budget.reasoningRows === 0
      ? undefined
      : tailPreview(
          collapseToSingleLine(visibleReasoningText),
          Math.max(1, textWidth - REASONING_PREVIEW_PREFIX.length),
        );
  const compactionPreview =
    budget.compactionRows === 0
      ? undefined
      : tailPreview(
          collapseToSingleLine(visibleCompactionText),
          Math.max(1, textWidth - 2),
        );

  const visibleTools = runningTools.slice(
    Math.max(0, runningTools.length - budget.toolCount),
  );
  const visibleCommandRuns = runningCommandRuns.slice(
    Math.max(0, runningCommandRuns.length - budget.commandRunCount),
  );
  const visibleSubagents = runningSubagents.slice(
    Math.max(0, runningSubagents.length - budget.subagentCount),
  );
  const visibleSteers = pendingSteers.slice(
    Math.max(0, pendingSteers.length - budget.steerCount),
  );

  return (
    <Box flexDirection="column" flexShrink={0} minHeight={1}>
      {compactionPreview === undefined ? null : (
        <LiveCompactionText text={compactionPreview} />
      )}
      {reasoningPreview === undefined ? null : (
        <LiveReasoningText text={reasoningPreview} />
      )}
      {assistantLines.length === 0 ? null : (
        <LiveAssistantText lines={assistantLines} />
      )}
      <ToolActivityList tools={visibleTools} cwd={cwd} />
      {visibleCommandRuns.map((run) => (
        <CommandRunGroup key={run.id} run={run} cwd={cwd} />
      ))}
      {visibleSubagents.map((run) => (
        <SubagentActivity key={run.runId} run={run} cwd={cwd} />
      ))}
      {visibleSteers.length === 0 ? null : (
        <PendingSteers prompts={visibleSteers} />
      )}
      <RunStatus
        running={running}
        {...(workingSeconds !== undefined ? { workingSeconds } : {})}
        {...(interruptNotice !== undefined ? { interruptNotice } : {})}
      />
    </Box>
  );
});

/** 折叠成单行尾部预览：多行推理在动态区滚屏会留下重复行。 */
function collapseToSingleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** 单行尾部预览；截掉了前面的内容就用 `…` 标出来（`…` 自己也占一列）。 */
function tailPreview(text: string, width: number): string | undefined {
  if (text === '') return undefined;
  const rows = tailVisualRows(text, width, 1);
  const tail = rows.at(-1);
  if (tail === undefined) return undefined;
  if (tail === text) return tail;
  return `…${
    tailVisualRows(text, Math.max(1, width - 1), 1)
      .at(-1)
      ?.trimStart() ?? ''
  }`;
}

function LiveCompactionText({ text }: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Text color={theme.accent} wrap="truncate">
      {`- ${text}`}
    </Text>
  );
}

function LiveReasoningText({ text }: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Text color={theme.textMuted} wrap="truncate">
      {`${REASONING_PREVIEW_PREFIX}${text}`}
    </Text>
  );
}

function LiveAssistantText({ lines }: { readonly lines: readonly string[] }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} color={theme.text} wrap="truncate">
          {`${index === 0 ? glyphs.assistant : ' '} ${line}`}
        </Text>
      ))}
    </Box>
  );
}

function PendingSteers({ prompts }: { readonly prompts: readonly string[] }) {
  const theme = useTheme();
  return (
    <Box marginTop={1} flexDirection="column" flexShrink={0}>
      <Text color={theme.warning}>Messages queued for the running turn</Text>
      {prompts.map((prompt, index) => (
        <Text key={`${index}:${prompt}`} color={theme.text} wrap="truncate">
          {`${glyphs.subagent} ${prompt}`}
        </Text>
      ))}
    </Box>
  );
}

function RunStatus({
  running,
  workingSeconds,
  interruptNotice,
}: {
  readonly running: boolean;
  readonly workingSeconds?: number;
  readonly interruptNotice?: string;
}) {
  const theme = useTheme();
  if (running) {
    return (
      <Box marginTop={1} flexShrink={0}>
        <Text color={theme.warning}>{`working ${workingSeconds ?? 0}s`}</Text>
      </Box>
    );
  }
  if (interruptNotice !== undefined) {
    return (
      <Box marginTop={1} flexShrink={0}>
        <Text color={theme.error}>{interruptNotice}</Text>
      </Box>
    );
  }
  return null;
}
