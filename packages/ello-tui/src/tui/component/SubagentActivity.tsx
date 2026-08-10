import { Box, Text, useStdout } from 'ink';

import type { SubagentRunView } from '../store/history-entry.js';
import { headVisualRows } from '../store/terminal-text.js';
import { buildToolCardModel } from '../store/tool-card.js';
import { useTheme } from '../theme/index.js';

const VISIBLE_TOOL_LIMIT = 4;
const RESULT_LINE_LIMIT = 3;

/** 主视图中的有界子代理摘要，运行态和静态历史共用同一套排版。 */
export function SubagentActivity({
  run,
  cwd,
}: {
  readonly run: SubagentRunView;
  readonly cwd: string;
}) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const visibleTools = run.tools.slice(-VISIBLE_TOOL_LIMIT);
  const hidden = Math.max(
    0,
    (run.toolCount ?? run.tools.length) - visibleTools.length,
  );
  const terminal = isTerminal(run.status);
  const preview = terminal
    ? previewLines(
        run.status === 'completed' ? run.output : run.error,
        Math.max(1, (stdout.columns ?? 100) - 8),
      )
    : [];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box minWidth={1}>
        <Text color={statusColor(run, theme)}>● </Text>
        <Text bold color={theme.accent}>
          {run.agentName}
        </Text>
        {run.description.trim() === '' ? null : (
          <Text color={theme.text} wrap="truncate">
            {`(${run.description.trim()})`}
          </Text>
        )}
      </Box>
      <Box marginLeft={2} flexDirection="column" minWidth={1}>
        {terminal ? (
          <Box minWidth={1}>
            <Text color={theme.borderActive}>⎿ </Text>
            <Text bold color={statusColor(run, theme)}>
              {statusLabel(run.status)}
            </Text>
            <Text color={theme.textMuted} wrap="truncate">
              {terminalMetrics(run)}
            </Text>
          </Box>
        ) : (
          <>
            {visibleTools.map((tool, index) => (
              <ToolSummary
                key={tool.id}
                tool={tool}
                cwd={cwd}
                branch={index === 0}
              />
            ))}
            <Box>
              <Text color={theme.borderActive}>
                {visibleTools.length === 0 ? '⎿ ' : '  '}
              </Text>
              <Text color={statusColor(run, theme)}>
                {run.status === 'queued' ? 'Queued...' : 'Running...'}
              </Text>
            </Box>
            {hidden > 0 ? (
              <Text color={theme.textMuted}>{`  … +${hidden} tool uses`}</Text>
            ) : null}
          </>
        )}
        {preview.map((line, index) => (
          <Text key={`${run.runId}:preview:${index}`} color={theme.text}>
            {`   ${line}`}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function ToolSummary({
  tool,
  cwd,
  branch,
}: {
  readonly tool: SubagentRunView['tools'][number];
  readonly cwd: string;
  readonly branch: boolean;
}) {
  const theme = useTheme();
  const model = buildToolCardModel(tool, { cwd });
  return (
    <Box minWidth={1}>
      <Text color={theme.borderActive}>{branch ? '⎿ ' : '  '}</Text>
      <Text color={theme.info}>{model.name}</Text>
      {model.summary === '' ? null : (
        <Text color={theme.textMuted} wrap="truncate">
          {`(${model.summary})`}
        </Text>
      )}
    </Box>
  );
}

function terminalMetrics(run: SubagentRunView): string {
  const metrics: string[] = [];
  if (run.toolCount !== undefined) {
    metrics.push(`${run.toolCount} tool uses`);
  }
  if (run.usage !== undefined) {
    metrics.push(
      `${formatTokens(run.usage.inputTokens + run.usage.outputTokens)} tokens`,
    );
  }
  const duration = elapsed(run);
  if (duration !== undefined) metrics.push(duration);
  return metrics.length === 0 ? '' : ` (${metrics.join(' · ')})`;
}

function previewLines(
  value: string | undefined,
  width: number,
): readonly string[] {
  if (value === undefined) return [];
  const normalized = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .slice(0, 480);
  if (normalized === '') return [];
  const { rows, truncated } = headVisualRows(
    normalized,
    width,
    RESULT_LINE_LIMIT,
  );
  if (!truncated || rows.length === 0) return rows;
  return [...rows.slice(0, -1), `${rows.at(-1) ?? ''}…`];
}

function elapsed(run: SubagentRunView): string | undefined {
  if (run.completedAt === undefined) return undefined;
  const milliseconds = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(milliseconds)) return undefined;
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function isTerminal(status: SubagentRunView['status']): boolean {
  return status !== 'queued' && status !== 'running';
}

function statusLabel(status: SubagentRunView['status']): string {
  switch (status) {
    case 'completed':
      return 'Done';
    case 'failed':
    case 'fail':
      return 'Failed';
    case 'killed':
      return 'Stopped';
    case 'recovered':
      return 'Recovered';
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
  }
}

function statusColor(
  run: SubagentRunView,
  theme: ReturnType<typeof useTheme>,
): string {
  if (run.status === 'failed' || run.status === 'fail') return theme.error;
  if (run.status === 'killed') return theme.warning;
  if (run.status === 'completed') return theme.success;
  if (run.status === 'running') return theme.warning;
  if (run.status === 'queued') return theme.info;
  return theme.warning;
}
