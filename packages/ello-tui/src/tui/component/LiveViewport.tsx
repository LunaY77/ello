import { Box, Text } from 'ink';
import { memo } from 'react';

import type { SubagentRunView, ToolCallView } from '../store/history-entry.js';
import { useTheme } from '../theme/index.js';
import { glyphs } from '../ui/glyphs.js';

import { ToolActivityList } from './ToolActivityList.js';

const SUBAGENT_VISIBLE_TOOL_LIMIT = 4;

/** live 区只接收当前增量状态；已提交历史由 TerminalHistoryOutput 冻结。 */
export const LiveViewport = memo(function LiveViewport({
  cwd,
  assistantText,
  runningTools,
  runningSubagents,
  running,
  workingSeconds,
  interruptNotice,
  pendingSteers = [],
}: {
  readonly cwd: string;
  readonly assistantText: string;
  readonly runningTools: readonly ToolCallView[];
  readonly runningSubagents: readonly SubagentRunView[];
  readonly running: boolean;
  readonly workingSeconds?: number;
  readonly interruptNotice?: string;
  readonly pendingSteers?: readonly string[];
}) {
  const visibleAssistantText = assistantText.trim();
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={1}>
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

function SubagentActivity({
  run,
  cwd,
}: {
  readonly run: SubagentRunView;
  readonly cwd: string;
}) {
  const theme = useTheme();
  const hidden = Math.max(0, run.tools.length - SUBAGENT_VISIBLE_TOOL_LIMIT);
  const visibleTools = run.tools.slice(-SUBAGENT_VISIBLE_TOOL_LIMIT);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1}>
        <Text color={run.status === 'fail' ? theme.error : theme.warning}>
          {glyphs.subagent}
        </Text>
        <Text color={theme.warning}>{run.agentName}</Text>
        <Text color={theme.textMuted}>
          {run.background ? 'background' : 'foreground'}
        </Text>
      </Box>
      <Text color={theme.text} wrap="wrap">
        {run.description}
      </Text>
      {hidden > 0 ? (
        <Text color={theme.textMuted}>{`  +${hidden} earlier tool calls`}</Text>
      ) : null}
      <ToolActivityList tools={visibleTools} cwd={cwd} indent={2} />
      {run.status === 'fail' && run.error !== undefined ? (
        <Text color={theme.error}>{run.error}</Text>
      ) : null}
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
