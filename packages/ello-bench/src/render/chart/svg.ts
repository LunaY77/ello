import type { SuiteReport } from '../../domain/contract/index.js';

interface BarDatum {
  readonly label: string;
  readonly value: number;
  readonly note: string;
  readonly color?: string;
}

export function renderCharts(
  report: SuiteReport,
): Readonly<Record<string, string>> {
  const passRate = report.agents.map((agent) => ({
    label: agent.agentId,
    value: agent.passRate ?? 0,
    note:
      agent.passRate === null
        ? `no valid sample, ${agent.invalidRuns} invalid`
        : `${agent.passedRuns}/${agent.validRuns} passed, ${agent.invalidRuns} invalid`,
  }));
  const paired = report.comparisons.flatMap((comparison) => [
    {
      label: `${comparison.leftAgentId} wins`,
      value: comparison.wins,
      note: `${comparison.matchedRuns} matched`,
      color: '#167c5a',
    },
    {
      label: `${comparison.leftAgentId} ties`,
      value: comparison.ties,
      note: `${comparison.excludedPairs} excluded`,
      color: '#65717d',
    },
    {
      label: `${comparison.leftAgentId} losses`,
      value: comparison.losses,
      note: `vs ${comparison.rightAgentId}`,
      color: '#c44e52',
    },
  ]);
  const taskRates = report.agents.flatMap((agent) =>
    agent.tasks.map((task) => ({
      label: `${task.taskId} / ${agent.agentId}`,
      value: task.passRate ?? 0,
      note:
        task.passRate === null
          ? 'unavailable'
          : `${task.passedRuns}/${task.validRuns}`,
    })),
  );
  const elapsed = report.agents.map((agent) => ({
    label: agent.agentId,
    value: (agent.resources.elapsedMs.median ?? 0) / 1000,
    note: `median seconds, ${agent.resources.elapsedMs.count} runs`,
    color: '#8d5b26',
  }));
  const rounds = report.agents.map((agent) => ({
    label: agent.agentId,
    value: agent.resources.rounds.median ?? 0,
    note: 'median normalized rounds',
    color: '#4472a8',
  }));
  const tokens = report.agents.flatMap(
    (agent) =>
      [
        {
          label: `${agent.agentId} non-cache input`,
          value: agent.resources.nonCachedInputTokens?.median ?? 0,
          note: 'median tokens',
          color: '#2166ac',
        },
        {
          label: `${agent.agentId} cache read`,
          value: agent.resources.cacheReadTokens.median ?? 0,
          note: 'median tokens',
          color: '#167c5a',
        },
        {
          label: `${agent.agentId} cache write`,
          value: agent.resources.cacheWriteTokens.median ?? 0,
          note: 'median tokens',
          color: '#8d5b26',
        },
        {
          label: `${agent.agentId} output`,
          value: agent.resources.outputTokens.median ?? 0,
          note: 'median tokens',
          color: '#b2182b',
        },
        ...(agent.resources.reasoningTokens?.median === null ||
        agent.resources.reasoningTokens?.median === undefined
          ? []
          : [
              {
                label: `${agent.agentId} reasoning`,
                value: agent.resources.reasoningTokens.median,
                note: 'median tokens',
                color: '#6a4c93',
              },
            ]),
      ] satisfies BarDatum[],
  );
  const tools = report.agents.map((agent) => ({
    label: agent.agentId,
    value: agent.resources.toolCalls.median ?? 0,
    note: 'median tool calls',
    color: '#6a4c93',
  }));
  return {
    'pass-rate-by-agent.svg': barChart(
      'Valid pass rate by agent',
      passRate,
      true,
    ),
    'paired-outcomes.svg': barChart('Paired outcomes', paired, false),
    'pass-rate-by-task.svg': barChart(
      'Task by agent pass rate',
      taskRates,
      true,
    ),
    'resource-tradeoff.svg': barChart('Median elapsed time', elapsed, false),
    'round-timeline.svg': barChart('Median model rounds', rounds, false),
    'token-breakdown.svg': barChart(
      'Median token accounting by agent',
      tokens,
      false,
    ),
    'tool-failure-pareto.svg': barChart('Median tool calls', tools, false),
  };
}

function barChart(
  title: string,
  data: readonly BarDatum[],
  proportion: boolean,
): string {
  const rows =
    data.length === 0
      ? [{ label: 'No data', value: 0, note: 'unavailable' }]
      : data;
  const width = 1200;
  const rowHeight = 34;
  const height = 110 + rows.length * rowHeight;
  const left = 330;
  const chartWidth = 700;
  const maximum = proportion ? 1 : Math.max(1, ...rows.map((row) => row.value));
  const content = rows
    .map((row, index) => {
      const y = 70 + index * rowHeight;
      const barWidth = Math.max(0, (row.value / maximum) * chartWidth);
      const label = proportion
        ? `${(row.value * 100).toFixed(1)}%`
        : compactNumber(row.value);
      return [
        `<text x="${left - 12}" y="${y + 16}" text-anchor="end" class="label">${escapeXml(row.label)}</text>`,
        `<rect x="${left}" y="${y}" width="${chartWidth}" height="22" fill="#ece8df"/>`,
        `<rect x="${left}" y="${y}" width="${barWidth.toFixed(2)}" height="22" fill="${row.color ?? '#167c5a'}"/>`,
        `<text x="${left + chartWidth + 12}" y="${y + 15}" class="value">${escapeXml(label)}  ${escapeXml(row.note)}</text>`,
      ].join('');
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0}.title{font:700 22px system-ui,sans-serif;fill:#20262d}.label{font-size:12px;fill:#20262d}.value{font-size:11px;fill:#58616b}</style><rect width="100%" height="100%" fill="#fff"/><text x="24" y="36" class="title">${escapeXml(title)}</text>${content}</svg>\n`;
}

function compactNumber(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}K`
      : value.toFixed(value < 10 ? 1 : 0);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
