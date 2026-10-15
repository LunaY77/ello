import { Box, Static, Text } from 'ink';

import type {
  AgentTaskDetail,
  AgentTaskEvent,
  AgentTaskResult,
  AgentTaskSummary,
} from '../../api/protocol-types.js';
import type { ToolCallView } from '../store/history-entry.js';
import { useTheme } from '../theme/index.js';

import { LiveViewport } from './LiveViewport.js';
import { ToolActivityList } from './ToolActivityList.js';

type TranscriptLine = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'reasoning';
  readonly text: string;
};

type StaticTranscriptItem =
  | {
      readonly id: string;
      readonly kind: 'header';
      readonly task: AgentTaskSummary;
      readonly taskPacket: AgentTaskDetail['taskPacket'];
    }
  | ({ readonly kind: 'line' } & TranscriptLine)
  | { readonly id: string; readonly kind: 'tool'; readonly tool: ToolCallView }
  | {
      readonly id: string;
      readonly kind: 'result';
      readonly result: AgentTaskResult;
    }
  | { readonly id: string; readonly kind: 'error'; readonly error: string };

interface TranscriptProjection {
  readonly committed: readonly StaticTranscriptItem[];
  readonly runningTools: readonly ToolCallView[];
  readonly liveReasoning: string;
}

/**
 * 已提交的 Subagent transcript 进入 shell scrollback，与主会话历史使用相同的 Static 边界。
 * 最终 `<agent-result>` envelope 由 Server 投影成结构化 result，TUI 不直接显示内部 JSON。
 */
export function AgentTranscriptHistoryOutput({
  task,
  detail,
  resetKey,
}: {
  readonly task: AgentTaskSummary;
  readonly detail?: AgentTaskDetail;
  readonly resetKey: number;
}) {
  if (detail === undefined) return null;
  const projection = project(detail.events);
  const items: StaticTranscriptItem[] = [
    {
      id: `${task.taskId}:header`,
      kind: 'header',
      task,
      taskPacket: detail.taskPacket,
    },
    ...projection.committed,
  ];
  if (detail.result !== undefined) {
    items.push({
      id: `${task.taskId}:result:${task.revision}`,
      kind: 'result',
      result: detail.result,
    });
  } else if (detail.error !== undefined) {
    items.push({
      id: `${task.taskId}:error:${task.revision}`,
      kind: 'error',
      error: detail.error,
    });
  }
  return (
    <Static key={`${resetKey}:${task.taskId}`} items={items}>
      {(item) => (
        <StaticTranscriptRow key={item.id} item={item} cwd={task.cwd} />
      )}
    </Static>
  );
}

/** 运行中的 Subagent 增量复用统一 live viewport，严格服从 dynamic frame 行数预算。 */
export function AgentTranscript({
  task,
  detail,
  maxRows,
  textWidth,
}: {
  readonly task: AgentTaskSummary;
  readonly detail?: AgentTaskDetail;
  readonly maxRows: number;
  readonly textWidth: number;
}) {
  const theme = useTheme();
  if (detail === undefined) {
    return <Text color={theme.textMuted}>Loading transcript...</Text>;
  }
  if (maxRows <= 0) return null;
  const projection = project(detail.events);
  return (
    <Box flexDirection="column">
      <Text color={statusColor(task.status, theme)}>{task.status}</Text>
      {maxRows > 1 && task.status !== 'queued' ? (
        <LiveViewport
          cwd={task.cwd}
          assistantText=""
          reasoningText={projection.liveReasoning}
          compactionText=""
          runningTools={projection.runningTools}
          runningCommandRuns={[]}
          runningSubagents={[]}
          running={task.status === 'running'}
          maxRows={maxRows - 1}
          textWidth={textWidth}
        />
      ) : null}
    </Box>
  );
}

function StaticTranscriptRow({
  item,
  cwd,
}: {
  readonly item: StaticTranscriptItem;
  readonly cwd: string;
}) {
  const theme = useTheme();
  if (item.kind === 'header') {
    const label = item.task.name ?? item.task.definitionName;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text color={theme.accent}>{`@${label}`}</Text>
          <Text color={theme.textMuted}>{item.task.definitionName}</Text>
          <Text color={theme.textMuted}>{item.task.isolation}</Text>
        </Box>
        <Text color={theme.text}>{item.task.description}</Text>
        <Text color={theme.textMuted} wrap="truncate-middle">
          {item.task.cwd}
        </Text>
        <Text
          color={theme.textMuted}
        >{`Task: ${item.taskPacket.objective}`}</Text>
        <Text color={theme.textMuted}>{`Scope: ${item.taskPacket.scope}`}</Text>
      </Box>
    );
  }
  if (item.kind === 'line') {
    return (
      <Box marginBottom={1}>
        <TranscriptLineRow line={item} />
      </Box>
    );
  }
  if (item.kind === 'tool') {
    return <ToolActivityList tools={[item.tool]} cwd={cwd} expanded />;
  }
  if (item.kind === 'error') {
    return (
      <Box marginBottom={1}>
        <Text color={theme.error}>{item.error}</Text>
      </Box>
    );
  }
  return <StructuredResult result={item.result} />;
}

function TranscriptLineRow({ line }: { readonly line: TranscriptLine }) {
  const theme = useTheme();
  if (line.role === 'reasoning') {
    return <AgentReasoningText text={line.text} />;
  }
  return (
    <Text color={theme.text}>
      {line.role === 'user' ? `> ${line.text}` : `* ${line.text}`}
    </Text>
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

function StructuredResult({ result }: { readonly result: AgentTaskResult }) {
  const theme = useTheme();
  const details = resultDetails(result);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={statusColor(result.status, theme)}>
        {`${statusLabel(result.status)}: ${result.summary}`}
      </Text>
      {details.map((detail) => (
        <Text key={detail} color={theme.text}>
          {detail}
        </Text>
      ))}
    </Box>
  );
}

function resultDetails(result: AgentTaskResult): readonly string[] {
  switch (result.status) {
    case 'completed':
      return [
        ...result.evidence.map((item) => `Evidence: ${item}`),
        ...result.remainingRisks.map((item) => `Risk: ${item}`),
      ];
    case 'failed':
      return [
        result.error,
        ...result.evidence.map((item) => `Evidence: ${item}`),
      ];
    case 'blocked':
      return [
        result.blockingReason,
        `Question: ${result.questionForUser}`,
        ...result.completedWork.map((item) => `Completed: ${item}`),
        ...result.evidence.map((item) => `Evidence: ${item}`),
      ];
    case 'stopped':
      return [
        result.reason,
        ...result.partialWork.map((item) => `Partial: ${item}`),
        ...result.evidence.map((item) => `Evidence: ${item}`),
      ];
  }
}

function project(events: readonly AgentTaskEvent[]): TranscriptProjection {
  const committed: StaticTranscriptItem[] = [];
  const tools = new Map<string, ToolCallView>();
  const reasoningDeltas = new Map<string, string>();
  for (const event of events) {
    const payload = objectPayload(event);
    if (event.eventType === 'steer.queued') {
      const text = stringField(payload, 'text');
      if (text !== undefined) {
        committed.push({
          id: eventId(event),
          kind: 'line',
          role: 'user',
          text,
        });
      }
    }
    if (event.eventType === 'messageCompleted') {
      const text = stringField(payload, 'text');
      if (text !== undefined && text.trim() !== '' && !isResultEnvelope(text)) {
        committed.push({
          id: eventId(event),
          kind: 'line',
          role: 'assistant',
          text,
        });
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
        committed.push({
          id: eventId(event),
          kind: 'line',
          role: 'reasoning',
          text,
        });
      }
    }
    updateTool(tools, committed, event, payload);
  }
  return {
    committed,
    runningTools: [...tools.values()],
    liveReasoning: [...reasoningDeltas.values()].join(''),
  };
}

function updateTool(
  tools: Map<string, ToolCallView>,
  committed: StaticTranscriptItem[],
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
    committed.push({
      id: eventId(event),
      kind: 'tool',
      tool: { ...current, status: 'ok', output: record.output },
    });
    tools.delete(toolCallId);
    return;
  }
  if (
    type === 'command.failed' ||
    type === 'command.denied' ||
    type === 'command.blocked' ||
    type === 'command.interrupted'
  ) {
    committed.push({
      id: eventId(event),
      kind: 'tool',
      tool: {
        ...current,
        status: 'fail',
        error: { message: stringField(record, 'error') ?? 'Command failed.' },
      },
    });
    tools.delete(toolCallId);
  }
}

function isResultEnvelope(text: string): boolean {
  return /^\s*<agent-result>[\s\S]*<\/agent-result>\s*$/u.test(text);
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

function statusColor(
  status: AgentTaskSummary['status'],
  theme: ReturnType<typeof useTheme>,
): string {
  if (status === 'completed') return theme.success;
  if (status === 'failed') return theme.error;
  if (status === 'stopped' || status === 'blocked') return theme.warning;
  if (status === 'running') return theme.warning;
  return theme.info;
}

function statusLabel(status: AgentTaskResult['status']): string {
  switch (status) {
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Blocked';
    case 'stopped':
      return 'Stopped';
  }
}
