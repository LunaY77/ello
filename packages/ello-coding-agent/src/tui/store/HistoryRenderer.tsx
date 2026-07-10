import { Box, Text } from 'ink';

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

export function renderHistoryEntry(entry: HistoryEntry) {
  const content = renderHistoryEntryContent(entry);
  return (
    <Box key={entry.id} marginBottom={1}>
      {content}
    </Box>
  );
}

function renderHistoryEntryContent(entry: HistoryEntry) {
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
    case 'tool':
      return <HistoryTool tool={entry.tool} />;
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
        <Text color={tuiTokens.color.muted}>permissions: </Text>
        <Text color={tuiTokens.color.text}>
          {formatPermission(entry.approvalMode)}
        </Text>
      </Text>
    </Box>
  );
}

function HistoryTool({ tool }: { readonly tool: ToolCallView }) {
  const model = buildToolCardModel(tool);
  const color = toolStatusColor(tool.status);
  const prefix = tool.name === 'bash' ? '• ' : '  ';
  return (
    <Box flexDirection="column">
      <Text color={color} wrap="wrap">
        {`${prefix}${tool.status === 'fail' ? 'Failed ' : ''}${model.headline}${model.metaRight !== '' ? `  ${model.metaRight}` : ''}`}
      </Text>
      {model.details.length > 0 ? (
        <Text
          color={tuiTokens.color.muted}
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
      {model.truncationNotice !== undefined ? (
        <Text
          color={tuiTokens.color.warning}
        >{`  ${model.truncationNotice}`}</Text>
      ) : null}
      {model.diff !== undefined ? (
        <DiffPreview diff={model.diff} file={model.summary} />
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
    case 'dont-ask':
      return 'no prompts';
    case 'accept-edits':
      return 'auto-accept edits';
    default:
      return mode;
  }
}
