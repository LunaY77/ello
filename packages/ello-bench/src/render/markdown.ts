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
    '## Resources',
    '',
    'Only completed runs with normalized evidence contribute resource values. Mean is the arithmetic mean across measured runs; cache hit rate is averaged per run.',
    '',
    '### Aggregate (median)',
    '',
    ...resourceSummary(report, 'median'),
    '',
    '### Aggregate (mean)',
    '',
    ...resourceSummary(report, 'mean'),
    '',
    '### Resource coverage',
    '',
    '| agent | elapsed | rounds | tools | input / output | cache hit |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.agents.map(
      (agent) =>
        `| ${escapeCell(agent.agentId)} | ${agent.resources.elapsedMs.count} | ${agent.resources.rounds.count} | ${agent.resources.toolCalls.count} | ${agent.resources.inputTokens.count} / ${agent.resources.outputTokens.count} | ${agent.resources.cacheHitRate?.count ?? 0} |`,
    ),
    '',
    '### By task: outcome / elapsed / rounds / tools',
    '',
    'Task resource values are medians across measured replicates.',
    '',
    ...taskResourceSummary(report, 'execution'),
    '',
    '### By task: input / non-cache input / cache read / cache hit / output',
    '',
    ...taskResourceSummary(report, 'tokens'),
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
    '### Partial observations (excluded from scores)',
    '',
    ...(report.invalidLedger.every(
      (entry) => entry.partialEvidence === undefined,
    )
      ? ['No partial resource evidence was available.']
      : [
          '| task | agent | attempt | elapsed | rounds (completed / failed) | tools (failed) | observed input | observed output | usage coverage |',
          '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
          ...report.invalidLedger.flatMap((entry) => {
            const evidence = entry.partialEvidence;
            if (evidence === undefined) return [];
            return [
              `| ${entry.taskId} | ${entry.agentId} | ${entry.attemptId} | ${seconds(evidence.elapsedMs)} | ${evidence.rounds.observed} (${evidence.rounds.completed} / ${evidence.rounds.failed}) | ${evidence.tools.observed} (${evidence.tools.failed}) | ${count(evidence.usage.inputTokens)} | ${count(evidence.usage.outputTokens)} | ${evidence.usage.completeRounds}/${evidence.rounds.observed} rounds |`,
            ];
          }),
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

type ResourceStatistic = 'mean' | 'median';
type Distribution = SuiteReport['agents'][number]['resources']['elapsedMs'];

function resourceSummary(
  report: SuiteReport,
  statistic: ResourceStatistic,
): string[] {
  return [
    '| agent | elapsed | rounds | tools | input | non-cache input | cache read | cache write | cache hit rate | output | reasoning | main input | subagent input | combined input | main output | subagent output | combined output | main tools | subagent tools | combined tools |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.agents.map((agent) => {
      const resources = agent.resources;
      const threads = resources.threadUsage;
      return `| ${escapeCell(agent.agentId)} | ${seconds(statisticValue(resources.elapsedMs, statistic))} | ${count(statisticValue(resources.rounds, statistic))} | ${count(statisticValue(resources.toolCalls, statistic))} | ${count(statisticValue(resources.inputTokens, statistic))} | ${count(statisticValue(resources.nonCachedInputTokens, statistic))} | ${count(statisticValue(resources.cacheReadTokens, statistic))} | ${count(statisticValue(resources.cacheWriteTokens, statistic))} | ${percent(statisticValue(resources.cacheHitRate, statistic))} | ${count(statisticValue(resources.outputTokens, statistic))} | ${count(statisticValue(resources.reasoningTokens, statistic))} | ${count(statisticValue(threads?.mainInputTokens, statistic))} | ${count(statisticValue(threads?.subagentInputTokens, statistic))} | ${count(statisticValue(threads?.combinedInputTokens, statistic))} | ${count(statisticValue(threads?.mainOutputTokens, statistic))} | ${count(statisticValue(threads?.subagentOutputTokens, statistic))} | ${count(statisticValue(threads?.combinedOutputTokens, statistic))} | ${count(statisticValue(threads?.mainToolCalls, statistic))} | ${count(statisticValue(threads?.subagentToolCalls, statistic))} | ${count(statisticValue(threads?.combinedToolCalls, statistic))} |`;
    }),
  ];
}

function taskResourceSummary(
  report: SuiteReport,
  kind: 'execution' | 'tokens',
): string[] {
  const taskIds = report.agents[0]?.tasks.map((task) => task.taskId) ?? [];
  if (taskIds.length === 0)
    return ['No task-level resource data was available.'];
  return [
    `| task | ${report.agents.map((agent) => escapeCell(agent.agentId)).join(' | ')} |`,
    `| --- | ${report.agents.map(() => '---').join(' | ')} |`,
    ...taskIds.map(
      (taskId) =>
        `| ${escapeCell(taskId)} | ${report.agents
          .map((agent) => {
            const task = agent.tasks.find((entry) => entry.taskId === taskId);
            if (task === undefined) return 'missing';
            const resources = task.resources;
            if (kind === 'execution') {
              return `${taskOutcome(task)} / ${seconds(resources?.elapsedMs.median ?? null)} / ${count(resources?.rounds.median ?? null)} / ${count(resources?.toolCalls.median ?? null)}`;
            }
            return `${count(resources?.inputTokens.median ?? null)} / ${count(resources?.nonCachedInputTokens?.median ?? null)} / ${count(resources?.cacheReadTokens.median ?? null)} / ${percent(resources?.cacheHitRate?.median ?? null)} / ${count(resources?.outputTokens.median ?? null)}`;
          })
          .join(' | ')} |`,
    ),
  ];
}

function taskOutcome(
  task: SuiteReport['agents'][number]['tasks'][number],
): string {
  if (task.validRuns === 0) return 'invalid';
  if (task.validRuns === 1) return task.passedRuns === 1 ? 'pass' : 'fail';
  return `${task.passedRuns}/${task.validRuns} pass`;
}

function statisticValue(
  distribution: Distribution | undefined,
  statistic: ResourceStatistic,
): number | null {
  return distribution?.[statistic] ?? null;
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
