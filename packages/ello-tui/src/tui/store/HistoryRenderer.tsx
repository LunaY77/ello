import { Box, Text } from 'ink';

import type { UserInputResolution } from '../../api/protocol-types.js';
import { DiffPreview } from '../presenters/index.js';
import { useTheme, type TuiTheme } from '../theme/index.js';
import { glyphs } from '../ui/glyphs.js';

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
  const theme = useTheme();
  const content = renderHistoryEntryContent(entry, cwd, theme);
  return (
    <Box key={entry.id} marginBottom={1}>
      {content}
    </Box>
  );
}

function renderHistoryEntryContent(
  entry: HistoryEntry,
  cwd: string,
  theme: TuiTheme,
) {
  switch (entry.kind) {
    case 'session_header':
      return <SessionHeader entry={entry} />;
    case 'user':
      return (
        <Box flexDirection="column">
          {entry.text.split('\n').map((line, index) => (
            <Text key={`${entry.id}:${index}`} color={theme.success}>
              {`${index === 0 ? glyphs.user : '|'} ${line}`}
            </Text>
          ))}
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column">
          {entry.text.split('\n').map((line, index) => (
            <Text key={`${entry.id}:${index}`} color={theme.text}>
              {`${index === 0 ? glyphs.assistant : ' '} ${line}`}
            </Text>
          ))}
        </Box>
      );
    case 'skill':
      return (
        <Text color={theme.accent}>{`loaded [${entry.name}]`}</Text>
      );
    case 'tool':
      return <HistoryTool tool={entry.tool} cwd={cwd} />;
    case 'user_input':
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.accent}
          paddingX={1}
        >
          <Text color={theme.accent}>Question</Text>
          {entry.pending.params.questions.map((question) => (
            <Text key={question.id} color={theme.text}>
              {`${question.header}: ${question.question}`}
            </Text>
          ))}
          <Text color={theme.textMuted}>
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
      return <Text color={theme.accent}>{`- ${entry.text}`}</Text>;
    case 'diagnostic':
      return <Text color={theme.error}>{`x ${entry.text}`}</Text>;
  }
}

function summarizeUserInputResolution(resolution: UserInputResolution): string {
  if (resolution.status === 'denied') return 'Denied';
  if (resolution.status === 'chat') return `Chat: ${resolution.message}`;
  return resolution.answers
    .map((answer) => `${answer.questionId}: ${answer.selected.join(', ')}`)
    .join(' · ');
}

function SessionHeader({
  entry,
}: {
  readonly entry: Extract<HistoryEntry, { kind: 'session_header' }>;
}) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text color={theme.accent}>
          {`>_ Ello Coding Agent${entry.version ? ` (v${entry.version})` : ''}`}
        </Text>
        <Text color={theme.success}>ready</Text>
      </Box>
      <Text>
        <Text color={theme.textMuted}>profile: </Text>
        <Text color={theme.text}>{entry.profile}</Text>
      </Text>
      <Text>
        <Text color={theme.textMuted}>directory: </Text>
        <Text color={theme.text}>{compactPath(entry.cwd)}</Text>
      </Text>
      <Text>
        <Text color={theme.textMuted}>model: </Text>
        <Text color={theme.text}>{entry.model}</Text>
      </Text>
      <Text>
        <Text color={theme.textMuted}>mode: </Text>
        <Text color={theme.text}>{formatPermission(entry.mode)}</Text>
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
  const theme = useTheme();
  const model = buildToolCardModel(tool, { cwd });
  const color = toolStatusColor(theme, tool.status);
  const prefix = tool.name === 'bash' ? '• ' : '  ';
  return (
    <Box flexDirection="column">
      <Text color={color} wrap="truncate-middle">
        {`${prefix}${tool.status === 'fail' ? 'Failed ' : ''}${model.headline}${model.metaRight !== '' ? `  ${model.metaRight}` : ''}`}
      </Text>
      {model.details.length > 0 ? (
        <Text
          color={theme.textMuted}
          wrap="truncate"
        >{`  ${model.details.join(' · ')}`}</Text>
      ) : null}
      {model.outputPreview.length > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.textMuted}> └</Text>
          {model.outputPreview.map((line, index) => (
            <Text
              key={`${tool.id}:out:${index}`}
              color={theme.textMuted}
              wrap="truncate"
            >
              {`    ${line}`}
            </Text>
          ))}
        </Box>
      ) : null}
      {model.artifact !== undefined ? (
        <Box marginLeft={2} gap={2}>
          <Text color={theme.warning}>artifact</Text>
          <Text color={theme.warning} wrap="truncate-middle">
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
        <Text color={theme.error}>{`  ${tool.error.message}`}</Text>
      ) : null}
    </Box>
  );
}

function toolStatusColor(
  theme: TuiTheme,
  status: ToolCallView['status'],
): string {
  switch (status) {
    case 'running':
      return theme.warning;
    case 'ok':
      return theme.borderActive;
    case 'fail':
      return theme.error;
  }
}

function RunSeparator({ text }: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Text color={theme.border}>{`─ ${text} ${'─'.repeat(72)}`}</Text>
  );
}

function HistorySubagent({ run }: { readonly run: SubagentRunView }) {
  const theme = useTheme();
  const hidden = Math.max(0, run.tools.length - SUBAGENT_VISIBLE_TOOL_LIMIT);
  const visibleTools = run.tools.slice(-SUBAGENT_VISIBLE_TOOL_LIMIT);
  return (
    <Box flexDirection="column">
      <Text
        color={
          run.status === 'fail'
            ? theme.error
            : theme.warning
        }
      >
        {`${glyphs.subagent} ${run.agentName} ${run.background ? 'background' : 'foreground'} ${run.status}`}
      </Text>
      <Text color={theme.text}>{`  ${run.description}`}</Text>
      {hidden > 0 ? (
        <Text
          color={theme.textMuted}
        >{`  +${hidden} earlier tool calls`}</Text>
      ) : null}
      {visibleTools.map((tool) => (
        <Text key={tool.id} color={theme.textMuted}>
          {`  ${tool.name} ${tool.status}`}
        </Text>
      ))}
      {run.output !== undefined && run.output.trim() !== '' ? (
        <Text
          color={theme.textMuted}
        >{`  ${compactText(run.output)}`}</Text>
      ) : null}
      {run.error !== undefined ? (
        <Text color={theme.error}>{`  ${run.error}`}</Text>
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
      return 'bypass';
    case 'accept-edits':
      return 'accept-edits';
    case 'ask-before-changes':
      return 'ask-before-changes';
    default:
      return mode;
  }
}
