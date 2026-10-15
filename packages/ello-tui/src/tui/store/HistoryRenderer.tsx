import { Box, Text } from 'ink';
import stringWidth from 'string-width';

import type { UserInputResolution } from '../../api/protocol-types.js';
import { SubagentActivity } from '../component/SubagentActivity.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { DiffPreview } from '../presenters/index.js';
import { useTheme, type TuiTheme } from '../theme/index.js';
import { glyphs } from '../ui/glyphs.js';

import type {
  CommandRunView,
  HistoryEntry,
  ToolCallView,
} from './history-entry.js';
import { buildToolCardModel } from './tool-card.js';

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
    case 'reasoning':
      return <ReasoningText text={entry.text} />;
    case 'compaction':
      return <HistoryCompaction entry={entry} />;
    case 'skill':
      return <Text color={theme.accent}>{`loaded [${entry.name}]`}</Text>;
    case 'tool':
      return <HistoryTool tool={entry.tool} cwd={cwd} />;
    case 'command_run':
      return <CommandRunGroup run={entry.run} cwd={cwd} />;
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
      return <SubagentActivity run={entry.run} cwd={cwd} />;
    case 'separator':
      return <RunSeparator text={entry.text} />;
    case 'system':
      return <Text color={theme.accent}>{`- ${entry.text}`}</Text>;
    case 'diagnostic':
      return <Text color={theme.error}>{`x ${entry.text}`}</Text>;
  }
}

export function CommandRunGroup({
  run,
  cwd,
}: {
  readonly run: CommandRunView;
  readonly cwd: string;
}) {
  const theme = useTheme();
  const color =
    run.status === 'running'
      ? theme.warning
      : run.status === 'ok'
        ? theme.success
        : theme.error;
  return (
    <Box flexDirection="column">
      <Text color={color}>{`Command Run · ${run.status}`}</Text>
      {run.commands.map((command) => (
        <Box key={command.id} flexDirection="column" marginLeft={2}>
          <Text color={toolStatusColor(theme, command.status)}>
            {`step ${command.step} · ${command.name} · ${command.commandStatus}`}
          </Text>
          <HistoryTool tool={command} cwd={cwd} />
          {command.approval?.status === 'required' ? (
            <Text color={theme.warning}>
              {`  approval required${command.approval.reason === undefined ? '' : `: ${command.approval.reason}`}`}
            </Text>
          ) : null}
        </Box>
      ))}
      {run.error === undefined ? null : (
        <Text color={theme.error}>{`  ${run.error}`}</Text>
      )}
    </Box>
  );
}

function HistoryCompaction({
  entry,
}: {
  readonly entry: Extract<HistoryEntry, { kind: 'compaction' }>;
}) {
  const theme = useTheme();
  const messageCounts =
    entry.beforeMessageCount === undefined ||
    entry.afterMessageCount === undefined
      ? ''
      : ` · ${entry.beforeMessageCount} -> ${entry.afterMessageCount} messages`;
  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>
        {`- Context compacted${messageCounts} · ${formatHistoryTokens(entry.tokensBefore)} tokens before`}
      </Text>
      {entry.summary.split('\n').map((line, index) => (
        <Text key={`${entry.id}:summary:${index}`} color={theme.textMuted}>
          {`  ${line}`}
        </Text>
      ))}
    </Box>
  );
}

function ReasoningText({ text }: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.textMuted}>Thinking: </Text>
      <Box flexDirection="column" flexShrink={1}>
        {text.split('\n').map((line, index) => (
          <Text key={`${index}:${line}`} color={theme.textMuted} wrap="wrap">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function formatHistoryTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
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
  const { columns } = useTerminalSize();
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
        <Text color={theme.textMuted}>directory: </Text>
        <Text color={theme.text}>{compactPath(entry.cwd, columns)}</Text>
      </Text>
      <Text>
        <Text color={theme.textMuted}>agent: </Text>
        <Text color={theme.text}>{entry.agent}</Text>
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

/** 分隔线按实际终端宽度补齐；写死长度在窄终端会换行，在宽终端又填不满。 */
function RunSeparator({ text }: { readonly text: string }) {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const label = `─ ${text} `;
  const fill = Math.max(1, columns - 2 - stringWidth(label));
  return (
    <Text color={theme.border} wrap="truncate">
      {`${label}${'─'.repeat(fill)}`}
    </Text>
  );
}

/** 目录过长时保留尾部；上限跟随终端宽度，避免 header 边框被挤出屏幕。 */
function compactPath(cwd: string, columns: number): string {
  const home = process.env.HOME;
  const display =
    home !== undefined && cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;
  // 边框 2 + paddingX 2 + `directory: ` 11。
  const limit = Math.max(8, columns - 15);
  if (stringWidth(display) <= limit) return display;
  return `...${display.slice(-(limit - 3))}`;
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
