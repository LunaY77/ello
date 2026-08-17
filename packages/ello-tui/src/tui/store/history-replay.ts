import { isToolItem } from '../../api/protocol-types.js';
import type {
  ThreadItem,
  ThreadSnapshot,
  ToolThreadItem,
  Turn,
} from '../../api/protocol-types.js';

import type {
  HistoryEntry,
  CommandRunView,
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
      agent: snapshot.settings.agent,
      mode: snapshot.settings.mode,
      ...(serverVersion === undefined ? {} : { version: serverVersion }),
    },
  ];
  for (const turn of snapshot.turns) {
    const completedAfterTurn = turn.items.filter(
      (item) =>
        item.type === 'contextCompaction' &&
        turn.completedAt !== undefined &&
        Date.parse(item.createdAt) > Date.parse(turn.completedAt),
    );
    for (const item of orderReplayItems(turn.items)) {
      if (completedAfterTurn.includes(item)) continue;
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
    for (const item of completedAfterTurn) {
      const entry = itemToHistoryEntry(item);
      if (entry !== undefined) entries.push(entry);
    }
  }
  return entries;
}

function orderReplayItems(items: readonly ThreadItem[]): readonly ThreadItem[] {
  const assistantIndexes = items.flatMap((item, index) =>
    item.type === 'agentMessage' || item.type === 'plan' ? [index] : [],
  );
  if (assistantIndexes.length === 0) return items;

  const reasoningByAssistant = new Map<number, ThreadItem[]>();
  const unassignedReasoning = new Set<number>();
  items.forEach((item, index) => {
    if (item.type !== 'reasoning') return;
    const target =
      assistantIndexes.find((assistantIndex) => assistantIndex > index) ??
      [...assistantIndexes]
        .reverse()
        .find((assistantIndex) => assistantIndex < index);
    if (target === undefined) {
      unassignedReasoning.add(index);
      return;
    }
    const assigned = reasoningByAssistant.get(target) ?? [];
    assigned.push(item);
    reasoningByAssistant.set(target, assigned);
  });

  return items.flatMap((item, index) => {
    if (item.type === 'reasoning' && !unassignedReasoning.has(index)) return [];
    return [...(reasoningByAssistant.get(index) ?? []), item];
  });
}

export function itemToHistoryEntry(item: ThreadItem): HistoryEntry | undefined {
  if (item.type === 'commandRun') {
    return {
      kind: 'command_run',
      id: item.id,
      run: itemToCommandRunView(item),
    };
  }
  if (isToolItem(item)) {
    if (
      item.type === 'toolCall' &&
      item.toolName === 'spawn_agent' &&
      item.status === 'completed'
    ) {
      return undefined;
    }
    return { kind: 'tool', id: item.id, tool: itemToToolView(item) };
  }
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
        : { kind: 'reasoning', id: item.id, text: item.summary };
    case 'plan':
      return {
        kind: 'assistant',
        id: item.id,
        entryId: item.id,
        text: item.text,
      };
    case 'subagent':
      return { kind: 'subagent', id: item.id, run: itemToSubagentView(item) };
    case 'contextCompaction':
      return {
        kind: 'compaction',
        id: item.id,
        summary: item.summary,
        tokensBefore: item.tokensBefore,
        ...(item.beforeMessageCount === undefined
          ? {}
          : { beforeMessageCount: item.beforeMessageCount }),
        ...(item.afterMessageCount === undefined
          ? {}
          : { afterMessageCount: item.afterMessageCount }),
        ...(item.keptMessageCount === undefined
          ? {}
          : { keptMessageCount: item.keptMessageCount }),
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

export function itemToToolView(item: ToolThreadItem): ToolCallView {
  if (item.type === 'commandRun') {
    throw new Error('Command Run groups are not Tool rows.');
  }
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
              item.status === 'declined'
                ? 'Permission denied.'
                : (item.error ?? item.headline),
          },
        }
      : {}),
  };
}

export function itemToCommandRunView(
  item: Extract<ThreadItem, { type: 'commandRun' }>,
): CommandRunView {
  return {
    id: item.id,
    status:
      item.status === 'inProgress'
        ? 'running'
        : item.status === 'completed'
          ? 'ok'
          : item.status === 'interrupted'
            ? 'interrupted'
            : 'fail',
    commands: item.commands.map((command) => ({
      id: command.commandId,
      index: command.index,
      step: command.step,
      name: command.name,
      input: command.input,
      commandStatus: command.status,
      status:
        command.status === 'completed'
          ? 'ok'
          : command.status === 'pending' ||
              command.status === 'running' ||
              command.status === 'deferred'
            ? 'running'
            : 'fail',
      ...(command.output === undefined ? {} : { output: command.output }),
      ...(command.error === undefined
        ? command.status === 'blocked'
          ? {
              error: {
                message: `Blocked by ${command.blockedBy ?? 'an earlier failure'}.`,
              },
            }
          : {}
        : { error: { message: command.error } }),
      ...(command.approval === undefined
        ? {}
        : {
            approval: {
              status: command.approval.status,
              ...(command.approval.reason === undefined
                ? {}
                : { reason: command.approval.reason }),
            },
          }),
    })),
    ...(item.error === undefined ? {} : { error: item.error }),
  };
}

export function itemToSubagentView(
  item: Extract<ThreadItem, { type: 'subagent' }>,
): SubagentRunView {
  return {
    runId: item.id,
    agentName: item.agentName,
    description: item.description,
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
