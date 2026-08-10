import { Box, Text, useStdout } from 'ink';

import type {
  AgentTaskDetail,
  AgentTaskEvent,
  AgentTaskSummary,
} from '../../api/protocol-types.js';
import type { ToolCallView } from '../store/history-entry.js';
import { useTheme } from '../theme/index.js';

import { ToolActivityList } from './ToolActivityList.js';

/** 子代理详情视图，复用主界面的文本、reasoning 和 tool 视觉语言。 */
export function AgentTranscript({
  task,
  detail,
}: {
  readonly task: AgentTaskSummary;
  readonly detail?: AgentTaskDetail;
}) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const narrow = (stdout.columns ?? 100) < 60;
  const transcript =
    detail === undefined ? emptyTranscript() : project(detail.events);
  return (
    <Box flexDirection="column" width="100%">
      <Box
        flexDirection={narrow ? 'column' : 'row'}
        gap={narrow ? 0 : 1}
        marginBottom={1}
      >
        <Text
          color={theme.accent}
        >{`@${task.name ?? task.definitionName}`}</Text>
        <Text color={theme.textMuted}>{task.definitionName}</Text>
        <Text color={theme.textMuted}>{task.contextMode}</Text>
        <Text color={theme.textMuted}>{task.executionMode}</Text>
        <Text color={theme.textMuted}>{task.isolation}</Text>
        {task.parentTaskId === undefined ? null : (
          <Text color={theme.textMuted}>{`parent:${task.parentTaskId}`}</Text>
        )}
        <Text color={statusColor(task.status, theme)}>{task.status}</Text>
      </Box>
      <Text color={theme.textMuted} wrap="truncate-middle">
        {task.cwd}
      </Text>
      {detail === undefined ? (
        <Text color={theme.textMuted}>Loading transcript...</Text>
      ) : null}
      {transcript.lines.map((line) => (
        <Box key={line.id} marginTop={1} flexDirection="column">
          {line.kind === 'reasoning' ? (
            <AgentReasoningText text={line.text} />
          ) : (
            <Text color={theme.text}>
              {line.kind === 'user' ? `> ${line.text}` : `* ${line.text}`}
            </Text>
          )}
        </Box>
      ))}
      {transcript.liveReasoning !== '' ? (
        <AgentReasoningText text={transcript.liveReasoning} />
      ) : null}
      {transcript.liveMessage !== '' ? (
        <Text color={theme.text}>{`* ${transcript.liveMessage}`}</Text>
      ) : null}
      <ToolActivityList tools={transcript.tools} cwd={task.cwd} expanded />
      {detail?.error !== undefined ? (
        <Text color={theme.error}>{detail.error}</Text>
      ) : null}
      {detail?.output !== undefined && transcript.lines.length === 0 ? (
        <Text color={theme.text}>{detail.output}</Text>
      ) : null}
      {task.status === 'running' ? (
        <Text color={theme.warning}>working</Text>
      ) : null}
      {task.status === 'running' && task.executionMode === 'foreground' ? (
        <Text
          color={theme.textMuted}
        >{`${backgroundShortcut()} to background`}</Text>
      ) : null}
    </Box>
  );
}

function AgentReasoningText({ text }: { readonly text: string }) {
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

function backgroundShortcut(): string {
  return process.env.TMUX === undefined ? 'Ctrl+B' : 'Ctrl+B Ctrl+B';
}

interface TranscriptProjection {
  readonly lines: ReadonlyArray<{
    readonly id: string;
    readonly kind: 'user' | 'assistant' | 'reasoning';
    readonly text: string;
  }>;
  readonly tools: readonly ToolCallView[];
  readonly liveMessage: string;
  readonly liveReasoning: string;
}

function project(events: readonly AgentTaskEvent[]): TranscriptProjection {
  const lines: Array<TranscriptProjection['lines'][number]> = [];
  const tools = new Map<string, ToolCallView>();
  const messageDeltas = new Map<string, string>();
  const reasoningDeltas = new Map<string, string>();
  for (const event of events) {
    const payload = objectPayload(event);
    if (event.eventType === 'steer.queued') {
      const text = stringField(payload, 'text');
      if (text !== undefined)
        lines.push({ id: eventId(event), kind: 'user', text });
    }
    if (event.eventType === 'messageDelta') {
      appendDelta(messageDeltas, payload, 'messageId');
    }
    if (event.eventType === 'messageCompleted') {
      const id = stringField(payload, 'messageId');
      const text = stringField(payload, 'text');
      if (id !== undefined) messageDeltas.delete(id);
      if (text !== undefined && text.trim() !== '') {
        lines.push({ id: eventId(event), kind: 'assistant', text });
      }
    }
    if (event.eventType === 'reasoningDelta') {
      appendDelta(reasoningDeltas, payload, 'reasoningId');
    }
    if (event.eventType === 'reasoningCompleted') {
      const id = stringField(payload, 'reasoningId');
      const text = stringField(payload, 'text');
      if (id !== undefined) reasoningDeltas.delete(id);
      if (text !== undefined && text.trim() !== '') {
        lines.push({ id: eventId(event), kind: 'reasoning', text });
      }
    }
    updateTool(tools, event, payload);
  }
  return {
    lines,
    tools: [...tools.values()],
    liveMessage: [...messageDeltas.values()].join(''),
    liveReasoning: [...reasoningDeltas.values()].join(''),
  };
}

function updateTool(
  tools: Map<string, ToolCallView>,
  event: AgentTaskEvent,
  payload: Readonly<Record<string, unknown>>,
): void {
  if (event.eventType !== 'commandRunEvent') return;
  const commandEvent = recordField(payload, 'event');
  const record = recordField(commandEvent, 'record');
  const toolCallId = stringField(record, 'commandId');
  const type = stringField(commandEvent, 'type');
  if (toolCallId === undefined || type === undefined) return;
  if (type === 'command.started') {
    tools.set(toolCallId, {
      id: toolCallId,
      name: stringField(record, 'name') ?? 'command',
      input: record.input,
      status: 'running',
    });
    return;
  }
  const current = tools.get(toolCallId);
  if (current === undefined) return;
  if (type === 'command.completed') {
    tools.set(toolCallId, { ...current, status: 'ok', output: record.output });
  }
  if (
    type === 'command.failed' ||
    type === 'command.denied' ||
    type === 'command.blocked'
  ) {
    tools.set(toolCallId, {
      ...current,
      status: 'fail',
      error: { message: stringField(record, 'error') ?? 'Command failed.' },
    });
  }
}

function recordField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const field = value[key];
  return typeof field === 'object' && field !== null && !Array.isArray(field)
    ? (field as Readonly<Record<string, unknown>>)
    : {};
}

function appendDelta(
  target: Map<string, string>,
  payload: Readonly<Record<string, unknown>>,
  idField: string,
): void {
  const id = stringField(payload, idField);
  const text = stringField(payload, 'text');
  if (id === undefined || text === undefined) return;
  target.set(id, `${target.get(id) ?? ''}${text}`);
}

function objectPayload(
  event: AgentTaskEvent,
): Readonly<Record<string, unknown>> {
  return typeof event.payload === 'object' &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function eventId(event: AgentTaskEvent): string {
  return `${event.taskId}:${event.sequence}`;
}

function emptyTranscript(): TranscriptProjection {
  return { lines: [], tools: [], liveMessage: '', liveReasoning: '' };
}

function statusColor(
  status: AgentTaskSummary['status'],
  theme: ReturnType<typeof useTheme>,
): string {
  if (status === 'completed') return theme.success;
  if (status === 'failed' || status === 'killed') return theme.error;
  if (status === 'recovered') return theme.warning;
  if (status === 'running') return theme.warning;
  return theme.info;
}
