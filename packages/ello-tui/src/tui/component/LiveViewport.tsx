import { Box, Text } from 'ink';
import { memo } from 'react';

import type { SubagentRunView, ToolCallView } from '../store/history-entry.js';
import { useTheme } from '../theme/index.js';
import { glyphs } from '../ui/glyphs.js';

import { SubagentActivity } from './SubagentActivity.js';
import { ToolActivityList } from './ToolActivityList.js';

/** live 区只接收当前增量状态；已提交历史由 TerminalHistoryOutput 冻结。 */
export const LiveViewport = memo(function LiveViewport({
  cwd,
  assistantText,
  reasoningText,
  compactionText,
  runningTools,
  runningSubagents,
  running,
  workingSeconds,
  interruptNotice,
  pendingSteers = [],
}: {
  readonly cwd: string;
  readonly assistantText: string;
  readonly reasoningText: string;
  readonly compactionText: string;
  readonly runningTools: readonly ToolCallView[];
  readonly runningSubagents: readonly SubagentRunView[];
  readonly running: boolean;
  readonly workingSeconds?: number;
  readonly interruptNotice?: string;
  readonly pendingSteers?: readonly string[];
}) {
  const visibleAssistantText = assistantText.trim();
  const visibleReasoningText = reasoningText.trim();
  const visibleCompactionText = compactionText.trim();
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={1}>
      {visibleCompactionText !== '' ? (
        <LiveCompactionText text={visibleCompactionText} />
      ) : null}
      {visibleReasoningText !== '' ? (
        <LiveReasoningText text={visibleReasoningText} />
      ) : null}
      {visibleAssistantText !== '' ? (
        <LiveAssistantText text={visibleAssistantText} />
      ) : null}
      <ToolActivityList tools={runningTools} cwd={cwd} />
      {runningSubagents.map((run) => (
        <SubagentActivity key={run.runId} run={run} cwd={cwd} />
      ))}
      {pendingSteers.length > 0 ? (
        <PendingSteers prompts={pendingSteers} />
      ) : null}
      <RunStatus
        running={running}
        {...(workingSeconds !== undefined ? { workingSeconds } : {})}
        {...(interruptNotice !== undefined ? { interruptNotice } : {})}
      />
    </Box>
  );
});

function LiveCompactionText({ text }: { readonly text: string }) {
  const theme = useTheme();
  return <Text color={theme.accent}>{`- ${text}`}</Text>;
}

function LiveReasoningText({ text }: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.textMuted}>Thinking: </Text>
      <Box flexDirection="column" flexShrink={1} minWidth={1}>
        {text.split(/\r?\n/u).map((line, index) => (
          <Text key={`${index}:${line}`} color={theme.textMuted} wrap="wrap">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function LiveAssistantText({ text }: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, index) => (
        <Text key={`${index}:${line}`} color={theme.text} wrap="wrap">
          {`${index === 0 ? glyphs.assistant : ' '} ${line}`}
        </Text>
      ))}
    </Box>
  );
}

function PendingSteers({ prompts }: { readonly prompts: readonly string[] }) {
  const theme = useTheme();
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={theme.warning}>Messages queued for the running turn</Text>
      {prompts.map((prompt, index) => (
        <Text key={`${index}:${prompt}`} color={theme.text}>
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
      <Box marginTop={1}>
        <Text color={theme.warning}>{`working ${workingSeconds ?? 0}s`}</Text>
      </Box>
    );
  }
  if (interruptNotice !== undefined) {
    return (
      <Box marginTop={1}>
        <Text color={theme.error}>{interruptNotice}</Text>
      </Box>
    );
  }
  return null;
}
