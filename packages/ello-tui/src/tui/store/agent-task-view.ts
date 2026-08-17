import type { AgentTaskSummary } from '../../api/protocol-types.js';

import type { HistoryEntry, SubagentRunView } from './history-entry.js';

export function agentTaskToRunView(task: AgentTaskSummary): SubagentRunView {
  return {
    runId: task.taskId,
    revision: task.revision,
    agentName: task.name ?? task.definitionName,
    description: task.description,
    status: task.status,
    startedAt: task.startedAt ?? task.createdAt,
    ...(task.completedAt === undefined
      ? {}
      : { completedAt: task.completedAt }),
    toolCount: task.toolCount,
    tools: task.recentTools.map((tool) => ({
      id: tool.toolCallId,
      name: tool.name,
      input: inputFromInvocation(tool.name, tool.invocationPreview),
      status:
        tool.status === 'running'
          ? 'running'
          : tool.status === 'completed'
            ? 'ok'
            : 'fail',
    })),
    ...(task.usage === undefined ? {} : { usage: task.usage }),
    ...(task.resultPreview === undefined ? {} : { output: task.resultPreview }),
    ...(task.errorPreview === undefined ? {} : { error: task.errorPreview }),
  };
}

export function terminalAgentTaskEntry(
  task: AgentTaskSummary,
): Extract<HistoryEntry, { readonly kind: 'subagent' }> | undefined {
  if (task.status === 'queued' || task.status === 'running') return undefined;
  return {
    kind: 'subagent',
    id: `agent-task:${task.taskId}`,
    run: agentTaskToRunView(task),
  };
}

function inputFromInvocation(
  toolName: string,
  invocationPreview: string,
): unknown {
  if (invocationPreview === '') return {};
  if (toolName === 'bash') return { command: invocationPreview };
  if (toolName === 'grep' || toolName === 'glob') {
    return { pattern: invocationPreview };
  }
  if (toolName === 'web_fetch') return { url: invocationPreview };
  return { path: invocationPreview };
}
