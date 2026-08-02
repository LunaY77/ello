import type { SuiteReport } from '../domain/contract/index.js';
import {
  MIN_INTERVAL_SAMPLES,
  intervalOrNull,
} from '../domain/scoring/wilson.js';

export const CHART_FILENAMES = [
  'pass-rate-by-agent.svg',
  'paired-outcomes.svg',
  'pass-rate-by-task.svg',
  'resource-tradeoff.svg',
  'round-timeline.svg',
  'token-breakdown.svg',
  'tool-failure-pareto.svg',
] as const;

export function renderMarkdown(
  report: SuiteReport,
  runRoot: string,
  provenance: string,
): string {
  const lines = [
    '# Benchmark report',
    '',
    `- benchmark: \`${report.suite.benchmarkId}\` (${report.suite.displayName})`,
    `- task selection: ${report.suite.selectedTaskCount} selected / ${report.suite.upstreamTaskCount} upstream (${report.suite.selectionKind})`,
    `- runRoot: \`${runRoot}\``,
    `- configHash: \`${report.configHash}\``,
    `- planHash: \`${report.planHash}\``,
    `- reportGeneratedAt: \`${report.generatedAt}\``,
    `- plannedJobs: ${report.plannedJobs}, scoredJobs: ${report.scoredJobs}, invalidJobs: ${report.invalidJobs}`,
    `- publishable: **${String(report.publishable)}**`,
    '',
    '## Agents',
    '',
    '| agent | valid | passed | pass rate | 95% CI | invalid | task macro |',
    '| --- | ---: | ---: | ---: | --- | ---: | ---: |',
    ...report.agents.map((agent) => {
      const interval = intervalOrNull(agent.passedRuns, agent.validRuns);
      const ci =
        agent.passRate === null
          ? '--'
          : interval === null
            ? `n<${MIN_INTERVAL_SAMPLES} (n=${agent.validRuns})`
            : `${percent(interval.low)} - ${percent(interval.high)}`;
      return `| ${escapeCell(agent.agentId)} | ${agent.validRuns} | ${agent.passedRuns} | ${percent(agent.passRate)} | ${ci} | ${agent.invalidRuns} | ${percent(agent.taskMacroAverage)} |`;
    }),
    '',
    '## Resources (median)',
    '',
    '| agent | elapsed | rounds | tools | input | non-cache input | cache read | cache write | cache hit rate | output | reasoning | main input | subagent input |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.agents.map((agent) => {
      const threads = agent.resources.threadUsage;
      return `| ${escapeCell(agent.agentId)} | ${seconds(agent.resources.elapsedMs.median)} | ${count(agent.resources.rounds.median)} | ${count(agent.resources.toolCalls.median)} | ${count(agent.resources.inputTokens.median)} | ${count(agent.resources.nonCachedInputTokens?.median ?? null)} | ${count(agent.resources.cacheReadTokens.median)} | ${count(agent.resources.cacheWriteTokens.median)} | ${percent(agent.resources.cacheHitRate?.median ?? null)} | ${count(agent.resources.outputTokens.median)} | ${count(agent.resources.reasoningTokens?.median ?? null)} | ${count(threads?.mainInputTokens.median ?? null)} | ${count(threads?.subagentInputTokens.median ?? null)} |`;
    }),
    '',
    '## Comparisons',
    '',
    ...(report.comparisons.length === 0
      ? ['No agent pair was compared in this run.']
      : [
          '| pair | matched | excluded | wins | ties | losses | paired delta |',
          '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
          ...report.comparisons.map(
            (comparison) =>
              `| ${comparison.leftAgentId} vs ${comparison.rightAgentId} | ${comparison.matchedRuns} | ${comparison.excludedPairs} | ${comparison.wins} | ${comparison.ties} | ${comparison.losses} | ${percent(comparison.pairedPassRateDelta)} |`,
          ),
        ]),
    '',
    '## Infrastructure-invalid attempts',
    '',
    ...(report.invalidLedger.length === 0
      ? ['No attempt was rejected as infrastructure-invalid.']
      : [
          '| task | agent | kind / phase | diagnostic |',
          '| --- | --- | --- | --- |',
          ...report.invalidLedger.map(
            (entry) =>
              `| ${entry.taskId} | ${entry.agentId} | ${entry.failure.kind} / ${entry.failure.phase} | ${escapeCell(entry.failure.message)} |`,
          ),
        ]),
    '',
    ...(report.reportConfig.renderCharts
      ? [
          '## Charts',
          '',
          ...CHART_FILENAMES.map((name) => `- \`charts/${name}\``),
          '',
        ]
      : []),
    '---',
    '',
    `<sub>${provenance}</sub>`,
    '',
  ];
  return lines.join('\n');
}

function percent(value: number | null): string {
  return value === null ? '--' : `${(value * 100).toFixed(1)}%`;
}

function count(value: number | null): string {
  return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US');
}

function seconds(value: number | null): string {
  return value === null
    ? 'n/a'
    : `${Math.round(value / 1000).toLocaleString('en-US')} s`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
