import type {
  ThreadItem,
  ThreadSnapshot,
  Turn,
} from '../../api/protocol-types.js';

import type {
  HistoryEntry,
  SubagentRunView,
  ToolCallView,
} from './history-entry.js';

/** 持久化 snapshot 是历史唯一主源；Client 不重放旧 runtime event。 */
export function snapshotToHistoryEntries(
  snapshot: ThreadSnapshot,
  serverVersion?: string,
): readonly HistoryEntry[] {
  const entries: HistoryEntry[] = [
    {
      kind: 'session_header',
      id: `thread-header-${snapshot.thread.id}`,
      threadId: snapshot.thread.id,
      cwd: snapshot.thread.cwd,
      profile: snapshot.settings.profile,
      model: snapshot.settings.model,
      mode: snapshot.settings.mode,
      ...(serverVersion === undefined ? {} : { version: serverVersion }),
    },
  ];
  for (const turn of snapshot.turns) {
    for (const item of turn.items) {
      if ('status' in item && item.status === 'inProgress') continue;
      const entry = itemToHistoryEntry(item);
      if (entry !== undefined) entries.push(entry);
    }
    if (turn.status !== 'inProgress') {
      entries.push({
        kind: 'separator',
        id: `turn-separator-${turn.id}`,
        text: workedLabel(turn),
      });
    }
  }
  return entries;
}

export function itemToHistoryEntry(item: ThreadItem): HistoryEntry | undefined {
  switch (item.type) {
    case 'userMessage':
      return {
        kind: 'user',
        id: item.id,
        entryId: item.id,
        turnId: item.turnId,
        text: item.text,
      };
    case 'agentMessage':
      return item.text.trim() === ''
        ? undefined
        : { kind: 'assistant', id: item.id, entryId: item.id, text: item.text };
    case 'reasoning':
      return item.summary.trim() === ''
        ? undefined
        : { kind: 'system', id: item.id, text: `reasoning: ${item.summary}` };
    case 'plan':
      return {
        kind: 'assistant',
        id: item.id,
        entryId: item.id,
        text: item.text,
      };
    case 'commandExecution':
    case 'fileChange':
    case 'toolCall':
      return { kind: 'tool', id: item.id, tool: itemToToolView(item) };
    case 'subagent':
      return { kind: 'subagent', id: item.id, run: itemToSubagentView(item) };
    case 'contextCompaction':
      return {
        kind: 'system',
        id: item.id,
        text: `context compacted: ${item.summary}`,
      };
    case 'notice':
      return { kind: 'system', id: item.id, text: item.message };
    case 'error':
      return {
        kind: 'diagnostic',
        id: item.id,
        text: `${item.code}: ${item.message}`,
      };
  }
}

export function itemToToolView(
  item: Extract<
    ThreadItem,
    { type: 'commandExecution' | 'fileChange' | 'toolCall' }
  >,
): ToolCallView {
  if (item.type === 'commandExecution') {
    return {
      id: item.id,
      name: 'bash',
      input: { command: item.command, cwd: item.cwd },
      status: itemStatus(item.status),
      output: {
        output: item.outputPreview ?? '',
        metadata: {
          kind: 'shell',
          command: item.command,
          path: item.cwd,
          ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
          ...(item.durationMs === undefined
            ? {}
            : { durationMs: item.durationMs }),
          ...(item.artifactId === undefined
            ? {}
            : { outputPath: item.artifactId }),
        },
      },
      ...(item.status === 'failed'
        ? { error: { message: 'Command failed.' } }
        : {}),
    };
  }
  if (item.type === 'fileChange') {
    return {
      id: item.id,
      name: 'write',
      input: { paths: item.changes.map((change) => change.path) },
      status: itemStatus(item.status),
      output: {
        metadata: {
          kind: 'edit',
          path: item.changes.map((change) => change.path).join(', '),
          fileChanges: item.changes,
        },
      },
      ...(item.status === 'failed' || item.status === 'declined'
        ? {
            error: {
              message:
                item.status === 'declined'
                  ? 'Permission denied.'
                  : 'File change failed.',
            },
          }
        : {}),
    };
  }
  return {
    id: item.id,
    name: item.toolName,
    input: item.metadata?.input ?? item.metadata ?? {},
    status: itemStatus(item.status),
    output: {
      output: item.outputPreview ?? '',
      metadata: {
        ...(item.metadata ?? {}),
        ...(item.artifactId === undefined
          ? {}
          : { outputPath: item.artifactId }),
      },
    },
    ...(item.status === 'failed' || item.status === 'declined'
      ? {
          error: {
            message:
              item.status === 'declined' ? 'Permission denied.' : item.headline,
          },
        }
      : {}),
  };
}

export function itemToSubagentView(
  item: Extract<ThreadItem, { type: 'subagent' }>,
): SubagentRunView {
  return {
    runId: item.id,
    agentName: item.agentName,
    description: item.description,
    background: item.background,
    status:
      item.status === 'inProgress'
        ? 'running'
        : item.status === 'completed'
          ? 'completed'
          : 'fail',
    startedAt: item.createdAt,
    tools: [],
    ...(item.status === 'inProgress' ? {} : { completedAt: item.createdAt }),
    ...(item.output === undefined ? {} : { output: item.output }),
    ...(item.status === 'failed' || item.status === 'declined'
      ? { error: item.output ?? item.description }
      : {}),
  };
}

function itemStatus(
  status: 'inProgress' | 'completed' | 'failed' | 'declined',
): ToolCallView['status'] {
  return status === 'inProgress'
    ? 'running'
    : status === 'completed'
      ? 'ok'
      : 'fail';
}

function workedLabel(turn: Turn): string {
  if (turn.completedAt === undefined) return `Turn ${turn.status}`;
  const durationMs = Math.max(
    0,
    Date.parse(turn.completedAt) - Date.parse(turn.startedAt),
  );
  const seconds = Math.round(durationMs / 1000);
  return turn.status === 'completed'
    ? `Worked for ${seconds}s`
    : `${turn.status}: ${turn.errorCode ?? 'turn ended'}`;
}
