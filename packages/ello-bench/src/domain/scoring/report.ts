import {
  AgentComparisonReportSchema,
  AgentReportSchema,
  SuiteReportSchema,
  TaskAgentReportSchema,
  type AgentComparisonReport,
  type AgentReport,
  type RunManifest,
  type SuiteManifest,
  type SuiteReport,
} from '../contract/index.js';

export interface AttemptMetrics {
  readonly elapsedMs: number;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly usageComplete: boolean;
  readonly toolAuditPassed: boolean;
  readonly phaseElapsedMs: Readonly<Record<string, number>>;
  readonly mainInputTokens: number | undefined;
  readonly subagentInputTokens: number | undefined;
  readonly combinedInputTokens: number | undefined;
  readonly mainOutputTokens: number | undefined;
  readonly subagentOutputTokens: number | undefined;
  readonly combinedOutputTokens: number | undefined;
  readonly mainToolCalls: number | undefined;
  readonly subagentToolCalls: number | undefined;
  readonly combinedToolCalls: number | undefined;
}

export interface SuiteReportInput {
  readonly suite: SuiteManifest;
  readonly finalAttempts: readonly RunManifest[];
  readonly metrics: ReadonlyMap<string, AttemptMetrics>;
  readonly invalidLedger: SuiteReport['invalidLedger'];
  readonly generatedAt: string;
}

type NumericMetricField = Exclude<
  keyof AttemptMetrics,
  'phaseElapsedMs' | 'usageComplete' | 'toolAuditPassed'
>;

export function buildSuiteReport(input: SuiteReportInput): SuiteReport {
  const completed = input.finalAttempts.filter(
    (attempt) => attempt.status === 'completed',
  );
  const invalid = input.finalAttempts.filter(
    (attempt) => attempt.status === 'invalid_infrastructure',
  );
  const taskIds = input.suite.selection.taskIds;
  const agents = input.suite.agents.map((agent) =>
    createAgentReport(agent.id, taskIds, input.finalAttempts, input.metrics),
  );
  const comparisons: AgentComparisonReport[] = [];
  for (let left = 0; left < input.suite.agents.length; left += 1) {
    for (let right = left + 1; right < input.suite.agents.length; right += 1) {
      const leftAgent = input.suite.agents[left];
      const rightAgent = input.suite.agents[right];
      if (leftAgent === undefined || rightAgent === undefined) {
        throw new Error('Suite Agent ordering is inconsistent.');
      }
      comparisons.push(
        createComparison(
          leftAgent.id,
          rightAgent.id,
          taskIds,
          input.finalAttempts,
          input.metrics,
        ),
      );
    }
  }
  return SuiteReportSchema.parse({
    schema: 'ello.benchmark.suite.v3',
    suite: input.suite.suite,
    reportConfig: input.suite.report,
    configHash: input.suite.configHash,
    planHash: input.suite.planHash,
    generatedAt: input.generatedAt,
    plannedJobs: input.suite.jobs.length,
    scoredJobs: completed.length,
    invalidJobs: invalid.length,
    publishable: isPublishable(input.suite, completed, invalid, input.metrics),
    agents,
    comparisons,
    invalidLedger: input.invalidLedger,
  });
}

function isPublishable(
  suite: SuiteManifest,
  completed: readonly RunManifest[],
  invalid: readonly RunManifest[],
  metrics: ReadonlyMap<string, AttemptMetrics>,
): boolean {
  const gates = suite.report.publishability;
  if (
    gates.requireCompleteMatrix &&
    (completed.length !== suite.jobs.length || invalid.length !== 0)
  ) {
    return false;
  }
  if (
    gates.requireCompleteUsage &&
    !completed.every((attempt) => {
      const metric = metrics.get(attempt.attemptId);
      return metric !== undefined && metric.usageComplete;
    })
  ) {
    return false;
  }
  if (
    gates.requireToolAudit &&
    !completed.every((attempt) => {
      const metric = metrics.get(attempt.attemptId);
      return metric !== undefined && metric.toolAuditPassed;
    })
  ) {
    return false;
  }
  return true;
}

function createAgentReport(
  agentId: string,
  taskIds: readonly string[],
  attempts: readonly RunManifest[],
  metrics: ReadonlyMap<string, AttemptMetrics>,
): AgentReport {
  const agentAttempts = attempts.filter(
    (attempt) => attempt.job.agentId === agentId,
  );
  const valid = agentAttempts.filter(
    (attempt) => attempt.status === 'completed',
  );
  const invalid = agentAttempts.filter(
    (attempt) => attempt.status === 'invalid_infrastructure',
  );
  const configHashes = new Set(
    agentAttempts.map((attempt) => attempt.job.agentConfigHash),
  );
  if (configHashes.size !== 1) {
    throw new Error(`Agent has inconsistent config hashes: ${agentId}.`);
  }
  const agentConfigHash = [...configHashes][0];
  if (agentConfigHash === undefined) {
    throw new Error(`Agent has no planned attempts: ${agentId}.`);
  }
  const tasks = taskIds.map((taskId) => {
    const taskRuns = valid.filter((attempt) => attempt.job.taskId === taskId);
    const passedRuns = taskRuns.filter(
      (attempt) => requiredReward(attempt) === 1,
    ).length;
    return TaskAgentReportSchema.parse({
      taskId,
      agentId,
      validRuns: taskRuns.length,
      passedRuns,
      passRate: taskRuns.length === 0 ? null : passedRuns / taskRuns.length,
    });
  });
  const taskRates = tasks.map((task) => task.passRate);
  // Degraded scored runs count toward pass rate but carry no resource metrics.
  const measured = valid.filter((attempt) => metrics.has(attempt.attemptId));
  const phaseNames = new Set(
    measured.flatMap((attempt) =>
      Object.keys(requiredMetrics(metrics, attempt).phaseElapsedMs),
    ),
  );
  const passedRuns = valid.filter(
    (attempt) => requiredReward(attempt) === 1,
  ).length;
  return AgentReportSchema.parse({
    agentId,
    agentConfigHash,
    validRuns: valid.length,
    passedRuns,
    passRate: valid.length === 0 ? null : passedRuns / valid.length,
    invalidRuns: invalid.length,
    taskMacroAverage: taskRates.every((rate) => rate !== null)
      ? taskRates.reduce((sum, rate) => sum + rate, 0) / taskRates.length
      : null,
    tasks,
    resources: {
      elapsedMs: metricDistribution(measured, metrics, 'elapsedMs'),
      rounds: metricDistribution(measured, metrics, 'rounds'),
      toolCalls: metricDistribution(measured, metrics, 'toolCalls'),
      inputTokens: metricDistribution(measured, metrics, 'inputTokens'),
      outputTokens: metricDistribution(measured, metrics, 'outputTokens'),
      cacheReadTokens: metricDistribution(measured, metrics, 'cacheReadTokens'),
      cacheWriteTokens: metricDistribution(
        measured,
        metrics,
        'cacheWriteTokens',
      ),
      phaseElapsedMs: Object.fromEntries(
        [...phaseNames]
          .sort((left, right) => left.localeCompare(right))
          .map((phase) => [
            phase,
            distribution(
              measured.flatMap((attempt) => {
                const value = requiredMetrics(metrics, attempt).phaseElapsedMs[
                  phase
                ];
                return value === undefined ? [] : [value];
              }),
            ),
          ]),
      ),
      threadUsage: {
        mainInputTokens: metricDistribution(
          measured,
          metrics,
          'mainInputTokens',
        ),
        subagentInputTokens: metricDistribution(
          measured,
          metrics,
          'subagentInputTokens',
        ),
        combinedInputTokens: metricDistribution(
          measured,
          metrics,
          'combinedInputTokens',
        ),
        mainOutputTokens: metricDistribution(
          measured,
          metrics,
          'mainOutputTokens',
        ),
        subagentOutputTokens: metricDistribution(
          measured,
          metrics,
          'subagentOutputTokens',
        ),
        combinedOutputTokens: metricDistribution(
          measured,
          metrics,
          'combinedOutputTokens',
        ),
        mainToolCalls: metricDistribution(measured, metrics, 'mainToolCalls'),
        subagentToolCalls: metricDistribution(
          measured,
          metrics,
          'subagentToolCalls',
        ),
        combinedToolCalls: metricDistribution(
          measured,
          metrics,
          'combinedToolCalls',
        ),
      },
    },
    evidenceCoverage: {
      usageCompleteRuns: measured.filter(
        (attempt) => requiredMetrics(metrics, attempt).usageComplete,
      ).length,
      usageUnavailableRuns: measured.filter(
        (attempt) => !requiredMetrics(metrics, attempt).usageComplete,
      ).length,
      toolAuditPassedRuns: measured.filter(
        (attempt) => requiredMetrics(metrics, attempt).toolAuditPassed,
      ).length,
    },
  });
}

function createComparison(
  leftAgentId: string,
  rightAgentId: string,
  taskIds: readonly string[],
  attempts: readonly RunManifest[],
  metrics: ReadonlyMap<string, AttemptMetrics>,
): AgentComparisonReport {
  const byKey = new Map<string, Map<string, RunManifest>>();
  for (const attempt of attempts) {
    const key = `${attempt.job.taskId}:${attempt.job.replicate}`;
    const entries = byKey.get(key) ?? new Map<string, RunManifest>();
    entries.set(attempt.job.agentId, attempt);
    byKey.set(key, entries);
  }
  const pairs: Array<{ left: RunManifest; right: RunManifest }> = [];
  let excludedPairs = 0;
  for (const entries of byKey.values()) {
    const left = entries.get(leftAgentId);
    const right = entries.get(rightAgentId);
    if (
      left === undefined ||
      right === undefined ||
      left.status !== 'completed' ||
      right.status !== 'completed'
    ) {
      excludedPairs += 1;
      continue;
    }
    pairs.push({ left, right });
  }
  const wins = pairs.filter(
    ({ left, right }) =>
      requiredReward(left) === 1 && requiredReward(right) === 0,
  ).length;
  const losses = pairs.filter(
    ({ left, right }) =>
      requiredReward(left) === 0 && requiredReward(right) === 1,
  ).length;
  const ties = pairs.length - wins - losses;
  const taskDeltas = taskIds.flatMap((taskId) => {
    const taskPairs = pairs.filter(({ left }) => left.job.taskId === taskId);
    if (taskPairs.length === 0) return [];
    return [
      average(taskPairs.map(({ left }) => requiredReward(left))) -
        average(taskPairs.map(({ right }) => requiredReward(right))),
    ];
  });
  return AgentComparisonReportSchema.parse({
    leftAgentId,
    rightAgentId,
    matchedRuns: pairs.length,
    excludedPairs,
    wins,
    ties,
    losses,
    pairedPassRateDelta:
      pairs.length === 0
        ? null
        : average(pairs.map(({ left }) => requiredReward(left))) -
          average(pairs.map(({ right }) => requiredReward(right))),
    taskMacroDelta: taskDeltas.length === 0 ? null : average(taskDeltas),
    durationRatio: ratioDistribution(pairs, metrics, 'elapsedMs'),
    inputTokenRatio: ratioDistribution(pairs, metrics, 'inputTokens'),
    outputTokenRatio: ratioDistribution(pairs, metrics, 'outputTokens'),
    toolCallRatio: ratioDistribution(pairs, metrics, 'toolCalls'),
    resourceCoverage: {
      durationPairs: ratioCount(pairs, metrics, 'elapsedMs'),
      inputTokenPairs: ratioCount(pairs, metrics, 'inputTokens'),
      outputTokenPairs: ratioCount(pairs, metrics, 'outputTokens'),
      toolCallPairs: ratioCount(pairs, metrics, 'toolCalls'),
    },
  });
}

function metricDistribution(
  attempts: readonly RunManifest[],
  metrics: ReadonlyMap<string, AttemptMetrics>,
  field: NumericMetricField,
) {
  return distribution(
    attempts.flatMap((attempt) => {
      const value = requiredMetrics(metrics, attempt)[field];
      return typeof value === 'number' ? [value] : [];
    }),
  );
}

function ratioDistribution(
  pairs: ReadonlyArray<{ left: RunManifest; right: RunManifest }>,
  metrics: ReadonlyMap<string, AttemptMetrics>,
  field: NumericMetricField,
) {
  const ratios = pairs.flatMap(({ left, right }) => {
    const denominator = metrics.get(right.attemptId)?.[field];
    const numerator = metrics.get(left.attemptId)?.[field];
    if (
      typeof denominator !== 'number' ||
      typeof numerator !== 'number' ||
      denominator === 0
    ) {
      return [];
    }
    return [numerator / denominator];
  });
  return ratios.length === 0 ? null : distribution(ratios);
}

function distribution(values: readonly number[]) {
  if (values.length === 0) return { count: 0, median: null, p95: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], percentileValue: number) {
  const index = (sorted.length - 1) * percentileValue;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = requiredNumber(sorted[lowerIndex]);
  const upper = requiredNumber(sorted[upperIndex]);
  return lower + (upper - lower) * (index - lowerIndex);
}

function average(values: readonly number[]): number {
  if (values.length === 0) throw new Error('Cannot average an empty set.');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function requiredMetrics(
  metrics: ReadonlyMap<string, AttemptMetrics>,
  attempt: RunManifest,
): AttemptMetrics {
  const value = metrics.get(attempt.attemptId);
  if (value === undefined) {
    throw new Error(`Missing metrics: ${attempt.attemptId}`);
  }
  return value;
}

function requiredReward(run: RunManifest): 0 | 1 {
  if (run.harness === undefined) {
    throw new Error(`Missing harness: ${run.attemptId}`);
  }
  return run.harness.reward;
}

function ratioCount(
  pairs: ReadonlyArray<{ left: RunManifest; right: RunManifest }>,
  metrics: ReadonlyMap<string, AttemptMetrics>,
  field: NumericMetricField,
): number {
  return pairs.filter(({ left, right }) => {
    const numerator = metrics.get(left.attemptId)?.[field];
    const denominator = metrics.get(right.attemptId)?.[field];
    return (
      typeof numerator === 'number' &&
      typeof denominator === 'number' &&
      denominator !== 0
    );
  }).length;
}

function requiredNumber(value: number | undefined): number {
  if (value === undefined) throw new Error('Required number is missing.');
  return value;
}
