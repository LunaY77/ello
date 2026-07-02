import { Box, Text } from 'ink';

import type { SubagentRunView, ToolCallView } from '../store/history-entry.js';
import { glyphs } from '../ui/glyphs.js';
import { tuiTokens } from '../ui/tokens.js';

import { ToolActivityList } from './ToolActivityList.js';

const SUBAGENT_VISIBLE_TOOL_LIMIT = 4;

export function LiveViewport({
  assistantText,
  runningTools,
  runningSubagents,
  running,
  workingSeconds,
  interruptNotice,
  pendingSteers = [],
}: {
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
      <ToolActivityList tools={runningTools} />
      {runningSubagents.map((run) => (
        <SubagentActivity key={run.runId} run={run} />
      ))}
      {pendingSteers.length > 0 ? <PendingSteers prompts={pendingSteers} /> : null}
      <RunStatus
        running={running}
        {...(workingSeconds !== undefined ? { workingSeconds } : {})}
        {...(interruptNotice !== undefined ? { interruptNotice } : {})}
      />
    </Box>
  );
}

function LiveAssistantText({ text }: { readonly text: string }) {
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, index) => (
        <Text key={`${index}:${line}`} color={tuiTokens.color.text} wrap="wrap">
          {`${index === 0 ? glyphs.assistant : ' '} ${line}`}
        </Text>
      ))}
    </Box>
  );
}

function SubagentActivity({ run }: { readonly run: SubagentRunView }) {
  const hidden = Math.max(0, run.tools.length - SUBAGENT_VISIBLE_TOOL_LIMIT);
  const visibleTools = run.tools.slice(-SUBAGENT_VISIBLE_TOOL_LIMIT);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1}>
        <Text color={run.status === 'fail' ? tuiTokens.color.danger : tuiTokens.color.warning}>
          {glyphs.subagent}
        </Text>
        <Text color={tuiTokens.color.warning}>{run.agentName}</Text>
        <Text color={tuiTokens.color.muted}>
          {run.background ? 'background' : 'foreground'}
        </Text>
      </Box>
      <Text color={tuiTokens.color.text} wrap="wrap">
        {run.description}
      </Text>
      {hidden > 0 ? (
        <Text color={tuiTokens.color.muted}>{`  +${hidden} earlier tool calls`}</Text>
      ) : null}
      <ToolActivityList tools={visibleTools} indent={2} />
      {run.status === 'fail' && run.error !== undefined ? (
        <Text color={tuiTokens.color.danger}>{run.error}</Text>
      ) : null}
    </Box>
  );
}

function PendingSteers({ prompts }: { readonly prompts: readonly string[] }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={tuiTokens.color.warning}>
        Messages queued for the running turn
      </Text>
      {prompts.map((prompt, index) => (
        <Text key={`${index}:${prompt}`} color={tuiTokens.color.text}>
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
  if (running) {
    return (
      <Box marginTop={1}>
        <Text color={tuiTokens.color.warning}>
          {`working ${workingSeconds ?? 0}s`}
        </Text>
      </Box>
    );
  }
  if (interruptNotice !== undefined) {
    return (
      <Box marginTop={1}>
        <Text color={tuiTokens.color.danger}>{interruptNotice}</Text>
      </Box>
    );
  }
  return null;
}
