import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { claudeCodeBaseUrlIssue } from './agents/claude-code/base-url.js';
import { diagnoseClaudeCodeProviderFailure } from './agents/claude-code/parser.js';
import {
  AgentComparisonReportSchema,
  AgentReportSchema,
  NormalizedAgentEvidenceSchema,
  PhaseTimingsArtifactSchema,
  RoundSchema,
  RunManifestSchema,
  SuiteManifestSchema,
  SuiteReportSchema,
  TaskAgentReportSchema,
  ToolAuditSchema,
  type AgentComparisonReport,
  type AgentReport,
  type NormalizedAgentEvidence,
  type RunManifest,
  type SuiteManifest,
  type SuiteReport,
} from './contracts.js';
import { sha256 } from './hash.js';
import { readJsonFile, writeJsonAtomic } from './io.js';

export async function generateSuiteReport(
  runRootInput: string,
): Promise<SuiteReport> {
  const runRoot = path.resolve(runRootInput);
  const report = await calculateSuiteReport(runRoot, new Date().toISOString());
  const resultsRoot = path.join(runRoot, 'results');
  await Promise.all([
    mkdir(path.join(resultsRoot, 'agents'), { recursive: true }),
    mkdir(path.join(resultsRoot, 'tasks'), { recursive: true }),
    mkdir(path.join(resultsRoot, 'comparisons'), { recursive: true }),
  ]);
  await Promise.all([
    ...report.agents.map((agent) =>
      writeJsonAtomic(
        path.join(resultsRoot, 'agents', `${agent.agentId}.json`),
        agent,
      ),
    ),
    ...report.agents.flatMap((agent) =>
      agent.tasks.map((task) =>
        writeJsonAtomic(
          path.join(resultsRoot, 'tasks', task.taskId, `${agent.agentId}.json`),
          task,
        ),
      ),
    ),
    ...report.comparisons.map((comparison) =>
      writeJsonAtomic(
        path.join(
          resultsRoot,
          'comparisons',
          `${comparison.leftAgentId}-vs-${comparison.rightAgentId}.json`,
        ),
        comparison,
      ),
    ),
  ]);
  await writeJsonAtomic(path.join(resultsRoot, 'suite-report.json'), report);
  return report;
}

export async function calculateSuiteReport(
  runRootInput: string,
  generatedAt: string,
): Promise<SuiteReport> {
  const runRoot = path.resolve(runRootInput);
  const suite = await readJsonFile(
    path.join(runRoot, 'suite-manifest.json'),
    SuiteManifestSchema,
  );
  const { allAttempts, finalAttempts } = await readAttempts(suite.attempts);
  const completed = finalAttempts.filter(
    (attempt) => attempt.status === 'completed',
  );
  const invalid = finalAttempts.filter(
    (attempt) => attempt.status === 'invalid_infrastructure',
  );
  const metrics = await loadMetrics(completed);
  const taskIds = suite.selection.taskIds;
  const agents = suite.agents.map((agent) =>
    createAgentReport(agent.id, taskIds, finalAttempts, metrics),
  );
  const comparisons: AgentComparisonReport[] = [];
  for (let left = 0; left < suite.agents.length; left += 1) {
    for (let right = left + 1; right < suite.agents.length; right += 1) {
      const leftAgent = suite.agents[left];
      const rightAgent = suite.agents[right];
      if (leftAgent === undefined || rightAgent === undefined) {
        throw new Error('Suite Agent ordering is inconsistent.');
      }
      comparisons.push(
        createComparison(
          leftAgent.id,
          rightAgent.id,
          taskIds,
          finalAttempts,
          metrics,
        ),
      );
    }
  }
  const invalidLedger = await Promise.all(
    allAttempts
      .filter((attempt) => attempt.status === 'invalid_infrastructure')
      .map(async (attempt) => ({
        attemptId: attempt.attemptId,
        jobId: attempt.job.jobId,
        taskId: attempt.job.taskId,
        agentId: attempt.job.agentId,
        failure: await reportedFailure(attempt),
      })),
  );
  return SuiteReportSchema.parse({
    schema: 'ello.benchmark.suite.v3',
    suite: suite.suite,
    reportConfig: suite.report,
    configHash: suite.configHash,
    planHash: suite.planHash,
    generatedAt,
    plannedJobs: suite.jobs.length,
    scoredJobs: completed.length,
    invalidJobs: invalid.length,
    publishable: isPublishable(suite, completed, invalid, metrics),
    agents,
    comparisons,
    invalidLedger,
  });
}

async function reportedFailure(
  run: RunManifest,
): Promise<NonNullable<RunManifest['failure']>> {
  const failure = requiredFailure(run);
  if (failure.kind !== 'provider') return failure;
  if (run.agent?.kind !== 'claude-code') return failure;
  const evidence = await readJsonFile(
    requiredReference(run.agentEvidence, 'agentEvidence', run).path,
    NormalizedAgentEvidenceSchema,
  );
  const providerMessage = diagnoseClaudeCodeProviderFailure(
    await readFile(evidence.rawSource.path, 'utf8'),
  );
  const baseUrlIssue = claudeCodeBaseUrlIssue(run.agent.connection.baseUrl);
  return {
    ...failure,
    message:
      baseUrlIssue === null
        ? providerMessage
        : `${baseUrlIssue} Provider response: ${providerMessage}`,
  };
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

interface AttemptMetrics {
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
}

type NumericMetricField = Exclude<
  keyof AttemptMetrics,
  'phaseElapsedMs' | 'usageComplete' | 'toolAuditPassed'
>;

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
  const jobs = agentAttempts.map((attempt) => attempt.job);
  const configHashes = new Set(jobs.map((job) => job.agentConfigHash));
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
  // Scored runs whose evidence is degraded have no resource metrics; they are
  // excluded from every resource and coverage statistic while still counting
  // toward pass rate.
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

async function loadMetrics(
  attempts: readonly RunManifest[],
): Promise<Map<string, AttemptMetrics>> {
  const metrics = new Map<string, AttemptMetrics>();
  for (const attempt of attempts) {
    // A run whose evidence could not be normalized still holds a verifier
    // score. It contributes to pass rate and carries no resource metrics.
    if (attempt.evidenceDegradation !== undefined) continue;
    const evidenceReference = requiredReference(
      attempt.agentEvidence,
      'Agent evidence',
      attempt,
    );
    const evidenceContent = await readFile(evidenceReference.path);
    if (sha256(evidenceContent) !== evidenceReference.sha256) {
      throw new Error(`Agent evidence checksum mismatch: ${attempt.attemptId}`);
    }
    const evidence = NormalizedAgentEvidenceSchema.parse(
      JSON.parse(evidenceContent.toString('utf8')) as unknown,
    );
    const auditReference = requiredReference(
      attempt.toolAudit,
      'tool audit',
      attempt,
    );
    const auditContent = await readFile(auditReference.path);
    if (sha256(auditContent) !== auditReference.sha256) {
      throw new Error(`Tool audit checksum mismatch: ${attempt.attemptId}`);
    }
    const audit = ToolAuditSchema.parse(
      JSON.parse(auditContent.toString('utf8')) as unknown,
    );
    const phasePath = requiredPath(
      attempt.phaseTimingsPath,
      'phase timings',
      attempt,
    );
    const rounds = parseRoundLines(
      await readFile(evidence.rounds.path, 'utf8'),
    );
    const phaseTimings = await readJsonFile(
      phasePath,
      PhaseTimingsArtifactSchema,
    );
    const inputTokens = await normalizedInputTokens(evidence);
    metrics.set(attempt.attemptId, {
      elapsedMs: requiredClient(attempt).durationMs,
      rounds: rounds.length,
      toolCalls: evidence.tools.total,
      inputTokens,
      outputTokens:
        evidence.usage.status === 'complete'
          ? evidence.usage.outputTokens
          : undefined,
      cacheReadTokens:
        evidence.usage.status === 'complete'
          ? (evidence.usage.cacheReadTokens ?? undefined)
          : undefined,
      cacheWriteTokens:
        evidence.usage.status === 'complete'
          ? (evidence.usage.cacheWriteTokens ?? undefined)
          : undefined,
      usageComplete: evidence.usage.status === 'complete',
      toolAuditPassed: audit.status === 'passed',
      phaseElapsedMs: Object.fromEntries(
        phaseTimings.phases.map((timing) => [timing.phase, timing.durationMs]),
      ),
    });
  }
  return metrics;
}

/**
 * Normalizes pre-fix Claude Code evidence while preserving current evidence.
 *
 * Early adapters persisted Anthropic's non-cache `input_tokens` directly. The
 * raw stream lets us identify that representation exactly: it equals the raw
 * non-cache sum. New adapters persist the total, so they pass through.
 */
async function normalizedInputTokens(
  evidence: NormalizedAgentEvidence,
): Promise<number | undefined> {
  if (evidence.usage.status !== 'complete') return undefined;
  if (evidence.kind !== 'claude-code') return evidence.usage.inputTokens;
  const raw = await claudeRawInputTokens(evidence.rawSource.path);
  if (
    raw === null ||
    raw.nonCached !== evidence.usage.inputTokens ||
    raw.cacheRead !== (evidence.usage.cacheReadTokens ?? 0) ||
    raw.cacheWrite !== (evidence.usage.cacheWriteTokens ?? 0)
  ) {
    return evidence.usage.inputTokens;
  }
  return raw.nonCached + raw.cacheRead + raw.cacheWrite;
}

async function claudeRawInputTokens(
  sourcePath: string,
): Promise<{ nonCached: number; cacheRead: number; cacheWrite: number } | null> {
  let content: string;
  try {
    content = await readFile(sourcePath, 'utf8');
  } catch {
    return null;
  }
  let nonCached = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let assistantEvents = 0;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (
      typeof record !== 'object' ||
      record === null ||
      (record as { type?: unknown }).type !== 'assistant'
    ) continue;
    const usage = (record as { message?: { usage?: unknown } }).message?.usage;
    if (typeof usage !== 'object' || usage === null) return null;
    const values = usage as Record<string, unknown>;
    if (
      !isNonnegativeInteger(values.input_tokens) ||
      !isOptionalNonnegativeInteger(values.cache_read_input_tokens) ||
      !isOptionalNonnegativeInteger(values.cache_creation_input_tokens)
    ) return null;
    nonCached += values.input_tokens;
    cacheRead += values.cache_read_input_tokens ?? 0;
    cacheWrite += values.cache_creation_input_tokens ?? 0;
    assistantEvents += 1;
  }
  return assistantEvents === 0 ? null : { nonCached, cacheRead, cacheWrite };
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalNonnegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonnegativeInteger(value);
}

async function readAttempts(
  attemptsByJob: Readonly<Record<string, readonly string[]>>,
): Promise<{
  readonly allAttempts: RunManifest[];
  readonly finalAttempts: RunManifest[];
}> {
  const allAttempts: RunManifest[] = [];
  const finalAttempts: RunManifest[] = [];
  for (const attemptPaths of Object.values(attemptsByJob)) {
    if (attemptPaths.length === 0) continue;
    const attempts = await Promise.all(
      attemptPaths.map((attemptPath) =>
        readJsonFile(attemptPath, RunManifestSchema),
      ),
    );
    for (const attempt of attempts) {
      if (
        attempt.status !== 'completed' &&
        attempt.status !== 'invalid_infrastructure'
      ) {
        throw new Error(`Attempt is not terminal: ${attempt.attemptId}`);
      }
    }
    allAttempts.push(...attempts);
    const finalAttempt = attempts.at(-1);
    if (finalAttempt === undefined)
      throw new Error('Final attempt is missing.');
    finalAttempts.push(finalAttempt);
  }
  return { allAttempts, finalAttempts };
}

function parseRoundLines(source: string) {
  return source
    .split(/\r?\n/u)
    .filter((line) => line !== '')
    .map((line) => RoundSchema.parse(JSON.parse(line) as unknown));
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

function requiredClient(run: RunManifest): NonNullable<RunManifest['client']> {
  if (run.client === undefined) {
    throw new Error(`Missing client: ${run.attemptId}`);
  }
  return run.client;
}

function requiredFailure(
  run: RunManifest,
): NonNullable<RunManifest['failure']> {
  if (run.failure === undefined) {
    throw new Error(`Missing failure: ${run.attemptId}`);
  }
  return run.failure;
}

function requiredPath(
  value: string | undefined,
  subject: string,
  run: RunManifest,
): string {
  if (value === undefined) {
    throw new Error(`Missing ${subject}: ${run.attemptId}`);
  }
  return value;
}

function requiredReference(
  value: { readonly path: string; readonly sha256: string } | undefined,
  subject: string,
  run: RunManifest,
): { readonly path: string; readonly sha256: string } {
  if (value === undefined) {
    throw new Error(`Missing ${subject}: ${run.attemptId}`);
  }
  return value;
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
