import { Box, Text } from 'ink';

import { summarizeUserInputResolution } from '../../user-input/recovery.js';
import { DiffPreview } from '../presenters/index.js';
import { glyphs } from '../ui/glyphs.js';
import { tuiTokens } from '../ui/tokens.js';

import type {
  HistoryEntry,
  SubagentRunView,
  ToolCallView,
} from './history-entry.js';
import { buildToolCardModel } from './tool-card.js';

const SUBAGENT_VISIBLE_TOOL_LIMIT = 4;

export function HistoryEntryRenderer({
  entry,
  cwd,
}: {
  readonly entry: HistoryEntry;
  readonly cwd: string;
}) {
  const content = renderHistoryEntryContent(entry, cwd);
  return (
    <Box key={entry.id} marginBottom={1}>
      {content}
    </Box>
  );
}

function renderHistoryEntryContent(entry: HistoryEntry, cwd: string) {
  switch (entry.kind) {
    case 'session_header':
      return <SessionHeader entry={entry} />;
    case 'user':
      return (
        <Box flexDirection="column">
          {entry.text.split('\n').map((line, index) => (
            <Text key={`${entry.id}:${index}`} color={tuiTokens.color.success}>
              {`${index === 0 ? glyphs.user : '|'} ${line}`}
            </Text>
          ))}
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column">
          {entry.text.split('\n').map((line, index) => (
            <Text key={`${entry.id}:${index}`} color={tuiTokens.color.text}>
              {`${index === 0 ? glyphs.assistant : ' '} ${line}`}
            </Text>
          ))}
        </Box>
      );
    case 'skill':
      return (
        <Text color={tuiTokens.color.accent}>{`loaded [${entry.name}]`}</Text>
      );
    case 'tool':
      return <HistoryTool tool={entry.tool} cwd={cwd} />;
    case 'user_input':
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tuiTokens.color.accent}
          paddingX={1}
        >
          <Text color={tuiTokens.color.accent}>Question</Text>
          {entry.pending.request.questions.map((question) => (
            <Text key={question.id} color={tuiTokens.color.text}>
              {`${question.header}: ${question.question}`}
            </Text>
          ))}
          <Text color={tuiTokens.color.muted}>
            {entry.resolution === undefined
              ? 'Awaiting your input'
              : summarizeUserInputResolution(entry.resolution)}
          </Text>
        </Box>
      );
    case 'subagent':
      return <HistorySubagent run={entry.run} />;
    case 'separator':
      return <RunSeparator text={entry.text} />;
    case 'system':
      return <Text color={tuiTokens.color.accent}>{`- ${entry.text}`}</Text>;
    case 'diagnostic':
      return <Text color={tuiTokens.color.danger}>{`x ${entry.text}`}</Text>;
  }
}

function SessionHeader({
  entry,
}: {
  readonly entry: Extract<HistoryEntry, { kind: 'session_header' }>;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tuiTokens.color.accent}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text color={tuiTokens.color.accent}>
          {`>_ Ello Coding Agent${entry.version ? ` (v${entry.version})` : ''}`}
        </Text>
        <Text color={tuiTokens.color.success}>ready</Text>
      </Box>
      <Text>
        <Text color={tuiTokens.color.muted}>profile: </Text>
        <Text color={tuiTokens.color.text}>{entry.profile}</Text>
      </Text>
      <Text>
        <Text color={tuiTokens.color.muted}>directory: </Text>
        <Text color={tuiTokens.color.text}>{compactPath(entry.cwd)}</Text>
      </Text>
      <Text>
        <Text color={tuiTokens.color.muted}>model: </Text>
        <Text color={tuiTokens.color.text}>{entry.model}</Text>
      </Text>
      <Text>
        <Text color={tuiTokens.color.muted}>mode: </Text>
        <Text color={tuiTokens.color.text}>{formatPermission(entry.mode)}</Text>
      </Text>
    </Box>
  );
}

function HistoryTool({
  tool,
  cwd,
}: {
  readonly tool: ToolCallView;
  readonly cwd: string;
}) {
  const model = buildToolCardModel(tool, { cwd });
  const color = toolStatusColor(tool.status);
  const prefix = tool.name === 'bash' ? '• ' : '  ';
  return (
    <Box flexDirection="column">
      <Text color={color} wrap="truncate-middle">
        {`${prefix}${tool.status === 'fail' ? 'Failed ' : ''}${model.headline}${model.metaRight !== '' ? `  ${model.metaRight}` : ''}`}
      </Text>
      {model.details.length > 0 ? (
        <Text
          color={tuiTokens.color.muted}
          wrap="truncate"
        >{`  ${model.details.join(' · ')}`}</Text>
      ) : null}
      {model.outputPreview.length > 0 ? (
        <Box flexDirection="column">
          <Text color={tuiTokens.color.muted}> └</Text>
          {model.outputPreview.map((line, index) => (
            <Text
              key={`${tool.id}:out:${index}`}
              color={tuiTokens.color.muted}
              wrap="truncate"
            >
              {`    ${line}`}
            </Text>
          ))}
        </Box>
      ) : null}
      {model.artifact !== undefined ? (
        <Box marginLeft={2} gap={2}>
          <Text color={tuiTokens.color.warning}>artifact</Text>
          <Text color={tuiTokens.color.warning} wrap="truncate-middle">
            {model.artifact.displayPath}
          </Text>
        </Box>
      ) : null}
      {model.diff !== undefined ? (
        <DiffPreview
          diff={model.diff}
          file={model.summary}
          {...(model.fileChanges !== undefined
            ? { fileChanges: model.fileChanges }
            : {})}
        />
      ) : null}
      {tool.status === 'fail' && tool.error !== undefined ? (
        <Text color={tuiTokens.color.danger}>{`  ${tool.error.message}`}</Text>
      ) : null}
    </Box>
  );
}

function toolStatusColor(status: ToolCallView['status']): string {
  switch (status) {
    case 'running':
      return tuiTokens.color.warning;
    case 'ok':
      return tuiTokens.color.borderActive;
    case 'fail':
      return tuiTokens.color.danger;
  }
}

function RunSeparator({ text }: { readonly text: string }) {
  return (
    <Text color={tuiTokens.color.border}>{`─ ${text} ${'─'.repeat(72)}`}</Text>
  );
}

function HistorySubagent({ run }: { readonly run: SubagentRunView }) {
  const hidden = Math.max(0, run.tools.length - SUBAGENT_VISIBLE_TOOL_LIMIT);
  const visibleTools = run.tools.slice(-SUBAGENT_VISIBLE_TOOL_LIMIT);
  return (
    <Box flexDirection="column">
      <Text
        color={
          run.status === 'fail'
            ? tuiTokens.color.danger
            : tuiTokens.color.warning
        }
      >
        {`${glyphs.subagent} ${run.agentName} ${run.background ? 'background' : 'foreground'} ${run.status}`}
      </Text>
      <Text color={tuiTokens.color.text}>{`  ${run.description}`}</Text>
      {hidden > 0 ? (
        <Text
          color={tuiTokens.color.muted}
        >{`  +${hidden} earlier tool calls`}</Text>
      ) : null}
      {visibleTools.map((tool) => (
        <Text key={tool.id} color={tuiTokens.color.muted}>
          {`  ${tool.name} ${tool.status}`}
        </Text>
      ))}
      {run.output !== undefined && run.output.trim() !== '' ? (
        <Text
          color={tuiTokens.color.muted}
        >{`  ${compactText(run.output)}`}</Text>
      ) : null}
      {run.error !== undefined ? (
        <Text color={tuiTokens.color.danger}>{`  ${run.error}`}</Text>
      ) : null}
    </Box>
  );
}

function compactText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= 240
    ? normalized
    : `${normalized.slice(0, 239)}...`;
}

function compactPath(cwd: string): string {
  const home = process.env.HOME;
  const display =
    home !== undefined && cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;
  if (display.length <= 68) {
    return display;
  }
  return `...${display.slice(-67)}`;
}

function formatPermission(mode: string): string {
  switch (mode) {
    case 'bypass':
      return 'YOLO mode';
    case 'accept-edits':
      return 'auto-accept edits';
    default:
      return mode;
  }
}
