import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  NormalizedAgentEvidenceSchema,
  PhaseTimingsArtifactSchema,
  RoundSchema,
  RunManifestSchema,
  SuiteManifestSchema,
  ToolAuditSchema,
  type CompleteUsageEvidence,
  type NormalizedAgentEvidence,
  type RunManifest,
  type SuiteReport,
  type UsageEvidence,
} from '../../domain/contract/index.js';
import { sha256 } from '../../domain/hash.js';
import {
  buildSuiteReport,
  type AttemptMetrics,
} from '../../domain/scoring/report.js';
import { claudeCodeBaseUrlIssue } from '../agent/claude-code/base-url.js';
import { diagnoseClaudeCodeProviderFailure } from '../agent/claude-code/parser.js';
import { readJsonFile, writeJsonAtomic } from '../io.js';

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
  const metrics = await loadMetrics(completed);
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
  return buildSuiteReport({
    suite,
    finalAttempts,
    metrics,
    invalidLedger,
    generatedAt,
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

async function loadMetrics(
  attempts: readonly RunManifest[],
): Promise<Map<string, AttemptMetrics>> {
  const metrics = new Map<string, AttemptMetrics>();
  for (const attempt of attempts) {
    // A degraded run contributes to pass rate but has no resource metrics.
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
    const normalizedUsage = await reportUsage(evidence);
    const inputTokens = normalizedUsage?.inputTokens;
    const outputTokens = normalizedUsage?.outputTokens;
    const cacheReadTokens = normalizedUsage?.cacheReadTokens;
    const cacheWriteTokens = normalizedUsage?.cacheWriteTokens;
    const mainUsage = evidence.threadUsage?.main ?? evidence.usage;
    const subagentUsage =
      evidence.threadUsage?.subagents ?? zeroCompleteUsage();
    const combinedUsage = evidence.threadUsage?.combined ?? evidence.usage;
    metrics.set(attempt.attemptId, {
      elapsedMs: requiredClient(attempt).durationMs,
      rounds: normalizedUsage?.roundCount ?? rounds.length,
      toolCalls: evidence.tools.total,
      inputTokens,
      nonCachedInputTokens: subtractCacheReadTokens(
        inputTokens,
        cacheReadTokens,
      ),
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRate:
        inputTokens === undefined ||
        inputTokens === 0 ||
        cacheReadTokens === undefined
          ? undefined
          : cacheReadTokens / inputTokens,
      reasoningTokens:
        evidence.usage.status === 'complete'
          ? (evidence.usage.reasoningTokens ?? undefined)
          : undefined,
      usageComplete: evidence.usage.status === 'complete',
      toolAuditPassed: audit.status === 'passed',
      phaseElapsedMs: Object.fromEntries(
        phaseTimings.phases.map((timing) => [timing.phase, timing.durationMs]),
      ),
      mainInputTokens:
        evidence.threadUsage === undefined
          ? inputTokens
          : usageValue(mainUsage, 'inputTokens'),
      subagentInputTokens: usageValue(subagentUsage, 'inputTokens'),
      combinedInputTokens: inputTokens,
      mainOutputTokens:
        evidence.threadUsage === undefined
          ? outputTokens
          : usageValue(mainUsage, 'outputTokens'),
      subagentOutputTokens: usageValue(subagentUsage, 'outputTokens'),
      combinedOutputTokens:
        evidence.threadUsage === undefined
          ? outputTokens
          : usageValue(combinedUsage, 'outputTokens'),
      mainToolCalls: usageValue(mainUsage, 'toolCalls'),
      subagentToolCalls: usageValue(subagentUsage, 'toolCalls'),
      combinedToolCalls: usageValue(combinedUsage, 'toolCalls'),
    });
  }
  return metrics;
}

function subtractCacheReadTokens(
  inputTokens: number | undefined,
  cacheReadTokens: number | undefined,
): number | undefined {
  if (inputTokens === undefined || cacheReadTokens === undefined) {
    return undefined;
  }
  const nonCachedInputTokens = inputTokens - cacheReadTokens;
  if (nonCachedInputTokens < 0) {
    throw new Error('Cache tokens exceed total input tokens.');
  }
  return nonCachedInputTokens;
}

function usageValue(
  usage: UsageEvidence,
  field: 'inputTokens' | 'outputTokens' | 'toolCalls',
): number | undefined {
  return usage.status === 'complete' ? usage[field] : undefined;
}

function zeroCompleteUsage(): CompleteUsageEvidence {
  return {
    status: 'complete',
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
  };
}

async function reportUsage(evidence: NormalizedAgentEvidence): Promise<
  | {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number | undefined;
      readonly cacheWriteTokens: number | undefined;
      readonly roundCount?: number;
    }
  | undefined
> {
  if (evidence.usage.status !== 'complete') return undefined;
  if (evidence.kind === 'claude-code') {
    const raw = await claudeTerminalUsage(evidence.rawSource.path);
    if (raw !== null) return raw;
  }
  return {
    inputTokens: evidence.usage.inputTokens,
    outputTokens: evidence.usage.outputTokens,
    cacheReadTokens: evidence.usage.cacheReadTokens ?? undefined,
    cacheWriteTokens: evidence.usage.cacheWriteTokens ?? undefined,
  };
}

async function claudeTerminalUsage(sourcePath: string): Promise<{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  roundCount: number;
} | null> {
  let content: string;
  try {
    content = await readFile(sourcePath, 'utf8');
  } catch {
    return null;
  }
  const assistantMessageIds = new Set<string>();
  let terminalUsage: Record<string, unknown> | undefined;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof record !== 'object' || record === null) return null;
    const item = record as Record<string, unknown>;
    if (item.type === 'assistant' && item.error === undefined) {
      const message = item.message;
      if (typeof message !== 'object' || message === null) return null;
      const messageId = (message as Record<string, unknown>).id;
      if (typeof messageId !== 'string' || messageId === '') return null;
      assistantMessageIds.add(messageId);
    }
    if (item.type === 'result') {
      if (terminalUsage !== undefined) return null;
      if (typeof item.usage !== 'object' || item.usage === null) return null;
      terminalUsage = item.usage as Record<string, unknown>;
    }
  }
  if (
    terminalUsage === undefined ||
    assistantMessageIds.size === 0 ||
    !isNonnegativeInteger(terminalUsage.input_tokens) ||
    !isNonnegativeInteger(terminalUsage.output_tokens) ||
    !isOptionalNonnegativeInteger(terminalUsage.cache_read_input_tokens) ||
    !isOptionalNonnegativeInteger(terminalUsage.cache_creation_input_tokens)
  ) {
    return null;
  }
  const cacheReadTokens = terminalUsage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = terminalUsage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens:
      terminalUsage.input_tokens + cacheReadTokens + cacheWriteTokens,
    outputTokens: terminalUsage.output_tokens,
    cacheReadTokens,
    cacheWriteTokens,
    roundCount: assistantMessageIds.size,
  };
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalNonnegativeInteger(
  value: unknown,
): value is number | undefined {
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
    if (finalAttempt === undefined) {
      throw new Error('Final attempt is missing.');
    }
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
