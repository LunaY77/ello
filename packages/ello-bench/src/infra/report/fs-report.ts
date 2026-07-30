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
    const inputTokens = await normalizedInputTokens(evidence);
    const mainUsage = evidence.threadUsage?.main ?? evidence.usage;
    const subagentUsage =
      evidence.threadUsage?.subagents ?? zeroCompleteUsage();
    const combinedUsage = evidence.threadUsage?.combined ?? evidence.usage;
    metrics.set(attempt.attemptId, {
      elapsedMs: requiredClient(attempt).durationMs,
      rounds: rounds.length,
      toolCalls: evidence.tools.total,
      inputTokens,
      outputTokens: usageValue(evidence.usage, 'outputTokens'),
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
      mainInputTokens: usageValue(mainUsage, 'inputTokens'),
      subagentInputTokens: usageValue(subagentUsage, 'inputTokens'),
      combinedInputTokens: inputTokens,
      mainOutputTokens: usageValue(mainUsage, 'outputTokens'),
      subagentOutputTokens: usageValue(subagentUsage, 'outputTokens'),
      combinedOutputTokens: usageValue(combinedUsage, 'outputTokens'),
      mainToolCalls: usageValue(mainUsage, 'toolCalls'),
      subagentToolCalls: usageValue(subagentUsage, 'toolCalls'),
      combinedToolCalls: usageValue(combinedUsage, 'toolCalls'),
    });
  }
  return metrics;
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

/**
 * Normalizes pre-fix Claude Code evidence while preserving current evidence.
 *
 * Early adapters persisted Anthropic's non-cache `input_tokens` directly. The
 * raw stream identifies that representation exactly; current totals pass
 * through unchanged.
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

async function claudeRawInputTokens(sourcePath: string): Promise<{
  nonCached: number;
  cacheRead: number;
  cacheWrite: number;
} | null> {
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
    ) {
      continue;
    }
    const usage = (record as { message?: { usage?: unknown } }).message?.usage;
    if (typeof usage !== 'object' || usage === null) return null;
    const values = usage as Record<string, unknown>;
    if (
      !isNonnegativeInteger(values.input_tokens) ||
      !isOptionalNonnegativeInteger(values.cache_read_input_tokens) ||
      !isOptionalNonnegativeInteger(values.cache_creation_input_tokens)
    ) {
      return null;
    }
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
