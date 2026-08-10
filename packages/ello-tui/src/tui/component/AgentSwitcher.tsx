import { Box, Text, useStdout } from 'ink';
import { useEffect, useState } from 'react';

import type { AgentTaskSummary } from '../../api/protocol-types.js';
import type {
  ActiveAgentView,
  AgentInputFocus,
} from '../hooks/use-agent-tasks.js';
import { AGENT_SWITCHER_MAX_TASK_ROWS } from '../store/live-budget.js';
import { useTheme } from '../theme/index.js';

export interface AgentSwitcherProps {
  readonly tasks: readonly AgentTaskSummary[];
  readonly activeView: ActiveAgentView;
  readonly focus: AgentInputFocus;
  readonly highlightedTaskId: 'main' | string;
}

type AgentRowDensity = 'full' | 'narrow' | 'compact';

/** 完整 footer 下方的常驻 Agent 树；状态文字不依赖颜色表达。 */
export function AgentSwitcher({
  tasks,
  activeView,
  focus,
  highlightedTaskId,
}: AgentSwitcherProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const density = densityFor(stdout.columns ?? 100);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!tasks.some((task) => task.status === 'running')) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [tasks]);
  if (tasks.length === 0) return null;
  const activeTaskId = activeView.kind === 'task' ? activeView.taskId : 'main';
  const ordered = orderTasks(tasks);
  // 列表必须有界：dock 撑满终端后 live 区让到 0 行也救不回来，frame 会顶过终端高度。
  const visible = visibleTaskWindow(ordered, highlightedTaskId);
  const hidden = ordered.length - visible.length;
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <AgentRow
        active={activeTaskId === 'main'}
        highlighted={focus === 'agent-switcher' && highlightedTaskId === 'main'}
        label="main"
        density={density}
      />
      {visible.map(({ task, depth }) => (
        <AgentRow
          key={task.taskId}
          active={activeTaskId === task.taskId}
          highlighted={
            focus === 'agent-switcher' && highlightedTaskId === task.taskId
          }
          label={task.name ?? task.definitionName}
          task={task}
          depth={depth}
          now={now || Date.parse(task.updatedAt)}
          density={density}
        />
      ))}
      {hidden > 0 ? (
        <Text color={theme.textMuted} wrap="truncate">
          {`  … +${hidden} more`}
        </Text>
      ) : null}
      {focus === 'agent-switcher' ? (
        <Text color={theme.textMuted} wrap="truncate">
          {navigationHint(tasks, highlightedTaskId)}
        </Text>
      ) : null}
    </Box>
  );
}

function AgentRow({
  active,
  highlighted,
  label,
  task,
  depth = 0,
  now,
  density,
}: {
  readonly active: boolean;
  readonly highlighted: boolean;
  readonly label: string;
  readonly task?: AgentTaskSummary;
  readonly depth?: number;
  readonly now?: number;
  readonly density: AgentRowDensity;
}) {
  const theme = useTheme();
  const left = `${highlighted ? '❯' : ' '} ${active ? '●' : '○'} ${'  '.repeat(depth)}${label}`;
  const metrics = taskMetrics(task, density, now);
  return (
    <Box width="100%">
      <Box
        {...(density === 'full' ? { width: 22 } : { flexGrow: 1 })}
        flexShrink={1}
        minWidth={1}
      >
        <Text
          color={
            highlighted
              ? theme.accent
              : active
                ? theme.text
                : task === undefined
                  ? theme.textMuted
                  : statusColor(task, theme)
          }
          wrap="truncate-middle"
        >
          {left}
        </Text>
      </Box>
      {density === 'full' ? (
        <Box flexGrow={1} flexShrink={1} minWidth={1}>
          <Text color={theme.textMuted} wrap="truncate">
            {task?.description ?? ''}
          </Text>
        </Box>
      ) : null}
      {task !== undefined && metrics !== '' ? (
        <Box marginLeft={1} flexShrink={0}>
          <Text color={statusColor(task, theme)}>{metrics}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function densityFor(columns: number): AgentRowDensity {
  if (columns < 40) return 'compact';
  if (columns <= 60) return 'narrow';
  return 'full';
}

function taskMetrics(
  task: AgentTaskSummary | undefined,
  density: AgentRowDensity,
  now: number | undefined,
): string {
  if (task === undefined) return '';
  if (task.status !== 'running' || density === 'compact') return task.status;
  const duration = elapsed(task, now ?? Date.parse(task.updatedAt));
  if (density === 'narrow') return `running · ${duration}`;
  const tokens = totalTokens(task);
  return tokens === undefined
    ? `running · ${duration}`
    : `running · ${duration} · ${formatTokens(tokens)}`;
}

function navigationHint(
  tasks: readonly AgentTaskSummary[],
  highlightedTaskId: 'main' | string,
): string {
  const task = tasks.find(
    (candidate) => candidate.taskId === highlightedTaskId,
  );
  return task !== undefined &&
    (task.status === 'queued' || task.status === 'running')
    ? 'Enter to view · x to stop'
    : 'Enter to view';
}

/** 以高亮项为中心的固定窗口，保证行数上界与 `agentSwitcherRows()` 一致。 */
function visibleTaskWindow(
  ordered: readonly { task: AgentTaskSummary; depth: number }[],
  highlightedTaskId: 'main' | string,
): readonly { task: AgentTaskSummary; depth: number }[] {
  if (ordered.length <= AGENT_SWITCHER_MAX_TASK_ROWS) return ordered;
  const active = ordered.findIndex(
    (entry) => entry.task.taskId === highlightedTaskId,
  );
  const start = Math.min(
    Math.max(0, active - AGENT_SWITCHER_MAX_TASK_ROWS + 1),
    ordered.length - AGENT_SWITCHER_MAX_TASK_ROWS,
  );
  return ordered.slice(start, start + AGENT_SWITCHER_MAX_TASK_ROWS);
}

function orderTasks(tasks: readonly AgentTaskSummary[]) {
  const result: Array<{ task: AgentTaskSummary; depth: number }> = [];
  const seen = new Set<string>();
  const append = (parentTaskId: string | undefined, depth: number) => {
    for (const task of tasks) {
      if (task.parentTaskId !== parentTaskId || seen.has(task.taskId)) continue;
      seen.add(task.taskId);
      result.push({ task, depth });
      append(task.taskId, depth + 1);
    }
  };
  append(undefined, 0);
  for (const task of tasks) {
    if (!seen.has(task.taskId)) result.push({ task, depth: 0 });
  }
  return result;
}

function elapsed(task: AgentTaskSummary, now: number): string {
  const started = Date.parse(task.startedAt ?? task.createdAt);
  const ended =
    task.completedAt === undefined ? now : Date.parse(task.completedAt);
  const seconds = Math.max(0, Math.floor((ended - started) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

function totalTokens(task: AgentTaskSummary): number | undefined {
  if (task.usage === undefined) return undefined;
  return task.usage.inputTokens + task.usage.outputTokens;
}

function statusColor(
  task: AgentTaskSummary,
  theme: ReturnType<typeof useTheme>,
): string {
  if (task.status === 'failed' || task.status === 'killed') return theme.error;
  if (task.status === 'completed') return theme.success;
  if (task.status === 'recovered') return theme.warning;
  if (task.status === 'running') return theme.warning;
  return theme.info;
}
