import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentProcessArtifactSchema,
  NormalizedAgentEvidenceSchema,
  RoundSchema,
  ToolAuditSchema,
  type AgentSpec,
  type BenchmarkRound,
  type NormalizedAgentEvidence,
  type NormalizedToolCall,
  type RunManifest,
  type ToolAudit,
} from '../../domain/contract/index.js';
import {
  auditElloTools,
  auditExternalTools,
} from '../../domain/evidence/routing-audit.js';
import { combineThreadRounds } from '../../domain/evidence/thread-evidence.js';
import { stableJson } from '../../domain/hash.js';
import type { AgentProcessExecution } from '../../ports/agent.js';
import { parseClaudeCodeEvidence } from '../agent/claude-code/parser.js';
import { parseCodexEvidence } from '../agent/codex/parser.js';
import {
  aggregateUsage,
  summarizeTools,
  terminalStopReason,
} from '../agent/evidence.js';
import { validateEventEvidence } from '../event-evidence.js';
import { normalizeEventCaptureSource } from '../rounds.js';

import { readReferencedJson, validateFileEvidence } from './artifact.js';

export async function validateAgentArtifacts(
  run: RunManifest,
  client: NonNullable<RunManifest['client']>,
): Promise<void> {
  const agent = required(run.agent, 'agent', run);
  const runtime = required(run.agentRuntime, 'agentRuntime', run);
  const processReference = required(run.agentProcess, 'agentProcess', run);
  const evidenceReference = required(run.agentEvidence, 'agentEvidence', run);
  const auditReference = required(run.toolAudit, 'toolAudit', run);
  const processArtifact = await readReferencedJson(
    run.attemptRoot,
    processReference,
    AgentProcessArtifactSchema,
  );
  if (stableJson(processArtifact.process) !== stableJson(client)) {
    throw new Error(`Agent process result mismatch: ${run.attemptId}`);
  }
  await Promise.all(
    [
      processArtifact.invocation,
      processArtifact.stdout,
      processArtifact.stderr,
    ].map((file) => validateFileEvidence(run.attemptRoot, file)),
  );
  const evidence = await readReferencedJson(
    run.attemptRoot,
    evidenceReference,
    NormalizedAgentEvidenceSchema,
  );
  const audit = await readReferencedJson(
    run.attemptRoot,
    auditReference,
    ToolAuditSchema,
  );
  await Promise.all([
    validateFileEvidence(run.attemptRoot, evidence.rawSource),
    validateFileEvidence(run.attemptRoot, evidence.rounds),
  ]);
  const rounds = parseRounds(await readFile(evidence.rounds.path, 'utf8'));
  if (rounds.length !== evidence.roundCount) {
    throw new Error(`Agent round count mismatch: ${run.attemptId}`);
  }
  if (stableJson(aggregateUsage(rounds)) !== stableJson(evidence.usage)) {
    throw new Error(`Agent usage aggregation mismatch: ${run.attemptId}`);
  }
  if (stableJson(summarizeTools(rounds)) !== stableJson(evidence.tools)) {
    throw new Error(`Agent tool summary mismatch: ${run.attemptId}`);
  }
  const execution: AgentProcessExecution = {
    process: processArtifact.process,
    startedAt: processArtifact.startedAt,
    completedAt: processArtifact.completedAt,
    artifact: processReference,
    stdoutPath: processArtifact.stdout.path,
    stderrPath: processArtifact.stderr.path,
  };
  let recomputed: {
    readonly evidence: NormalizedAgentEvidence;
    readonly rounds: readonly BenchmarkRound[];
    readonly tools: readonly NormalizedToolCall[];
  };
  let expectedAudit: ToolAudit;
  switch (agent.kind) {
    case 'ello': {
      ({ recomputed, expectedAudit } = await recomputeElloEvidence({
        run,
        agent,
        client,
        evidence,
      }));
      break;
    }
    case 'claude-code':
      if (
        runtime.kind === 'claude-code' &&
        runtime.adapterContractVersion === '1'
      ) {
        // Contract v1 counted Claude stream fragments as rounds. Its stored
        // evidence remains immutable and self-consistent; v2 reparsing is used
        // only for v2 artifacts and report-time resource correction.
        recomputed = {
          evidence,
          rounds,
          tools: rounds.flatMap((round) => round.toolCalls),
        };
        expectedAudit = auditExternalTools({
          tools: recomputed.tools,
          parserCoverage: evidence.parserCoverage,
          workspace: run.workspace,
        });
        break;
      }
      recomputed = await parseClaudeCodeEvidence({
        agent,
        execution,
        roundsPath: evidence.rounds.path,
        persistRounds: false,
      });
      expectedAudit = auditExternalTools({
        tools: recomputed.tools,
        parserCoverage: recomputed.evidence.parserCoverage,
        workspace: run.workspace,
      });
      break;
    case 'codex':
      recomputed = await parseCodexEvidence({
        agent,
        execution,
        roundsPath: evidence.rounds.path,
        persistRounds: false,
      });
      expectedAudit = auditExternalTools({
        tools: recomputed.tools,
        parserCoverage: recomputed.evidence.parserCoverage,
        workspace: run.workspace,
      });
      break;
  }
  if (stableJson(recomputed.rounds) !== stableJson(rounds)) {
    throw new Error(`Normalized Agent rounds mismatch: ${run.attemptId}`);
  }
  if (stableJson(recomputed.evidence) !== stableJson(evidence)) {
    throw new Error(`Normalized Agent evidence mismatch: ${run.attemptId}`);
  }
  if (stableJson(expectedAudit) !== stableJson(audit)) {
    throw new Error(`Agent tool audit mismatch: ${run.attemptId}`);
  }
  if (audit.status !== 'passed') {
    throw new Error(`Completed Agent tool audit failed: ${run.attemptId}`);
  }
  validateAgentRuntime(run, runtime, evidence.observedModel);
}

async function recomputeElloEvidence(options: {
  readonly run: RunManifest;
  readonly agent: Extract<AgentSpec, { readonly kind: 'ello' }>;
  readonly client: NonNullable<RunManifest['client']>;
  readonly evidence: NormalizedAgentEvidence;
}): Promise<{
  readonly recomputed: {
    readonly evidence: NormalizedAgentEvidence;
    readonly rounds: readonly BenchmarkRound[];
    readonly tools: readonly NormalizedToolCall[];
  };
  readonly expectedAudit: ToolAudit;
}> {
  const { run, agent, client, evidence } = options;
  const capture = await validateEventEvidence(
    path.dirname(evidence.rawSource.path),
  );
  if (capture.main.eventLogPath !== evidence.rawSource.path) {
    throw new Error(`Ello event source mismatch: ${run.attemptId}`);
  }
  const declaredThreads = evidence.threads;
  const declaredThreadUsage = evidence.threadUsage;
  if (declaredThreads === undefined || declaredThreadUsage === undefined) {
    throw new Error(`Ello thread evidence is missing: ${run.attemptId}`);
  }
  const captures = [
    { ...capture.main, kind: 'main' as const },
    ...capture.subagents.map((thread) => ({
      ...thread,
      kind: 'subagent' as const,
    })),
  ];
  if (declaredThreads.length !== captures.length) {
    throw new Error(`Ello thread count mismatch: ${run.attemptId}`);
  }
  const normalizedThreads = await Promise.all(
    captures.map(async (thread, index) => {
      const declared = declaredThreads[index];
      if (
        declared === undefined ||
        declared.threadId !== thread.threadId ||
        declared.kind !== thread.kind ||
        declared.rawSource.path !== thread.eventLogPath
      ) {
        throw new Error(
          `Ello thread identity mismatch: ${run.attemptId}/${thread.threadId}`,
        );
      }
      await Promise.all([
        validateFileEvidence(run.attemptRoot, declared.rawSource),
        validateFileEvidence(run.attemptRoot, declared.rounds),
      ]);
      const normalized = normalizeEventCaptureSource(
        await readFile(thread.eventLogPath, 'utf8'),
        client.timedOut,
      );
      const declaredRounds = parseRounds(
        await readFile(declared.rounds.path, 'utf8'),
      );
      if (
        declared.roundCount !== normalized.rounds.length ||
        stableJson(declaredRounds) !== stableJson(normalized.rounds) ||
        stableJson(declared.usage) !== stableJson(normalized.usage)
      ) {
        throw new Error(
          `Ello thread normalization mismatch: ${run.attemptId}/${thread.threadId}`,
        );
      }
      return { declared, normalized };
    }),
  );
  const main = normalizedThreads[0];
  if (main === undefined || main.declared.kind !== 'main') {
    throw new Error(`Ello main thread is missing: ${run.attemptId}`);
  }
  const combinedRounds = combineThreadRounds(
    normalizedThreads.flatMap((thread) => thread.normalized.rounds),
  );
  const combinedTools = normalizedThreads.flatMap(
    (thread) => thread.normalized.tools,
  );
  const subagentRounds = normalizedThreads
    .slice(1)
    .flatMap((thread) => thread.normalized.rounds);
  const expectedThreadUsage = {
    main: main.normalized.usage,
    subagents: aggregateUsage(subagentRounds),
    combined: aggregateUsage(combinedRounds),
  };
  if (stableJson(declaredThreadUsage) !== stableJson(expectedThreadUsage)) {
    throw new Error(`Ello thread usage mismatch: ${run.attemptId}`);
  }
  const elloRounds = requireElloRounds(combinedRounds, run.attemptId);
  validateElloRoundModels(agent, elloRounds, run.attemptId);
  const firstRound = requireElloRounds(
    main.normalized.rounds,
    run.attemptId,
  )[0];
  if (firstRound === undefined) {
    throw new Error(`Ello observed model is missing: ${run.attemptId}`);
  }
  const recomputedEvidence = NormalizedAgentEvidenceSchema.parse({
    ...evidence,
    observedModel: firstRound.apiModel,
    terminalStatus: client.timedOut
      ? 'timed_out'
      : main.normalized.providerFailure
        ? 'failed'
        : 'completed',
    providerFailure: main.normalized.providerFailure,
    terminalStopReason: terminalStopReason(main.normalized.rounds),
    unknownFields: [],
    roundCount: combinedRounds.length,
    usage: expectedThreadUsage.combined,
    tools: summarizeTools(combinedRounds),
    threads: normalizedThreads.map(({ declared, normalized }) => ({
      ...declared,
      roundCount: normalized.rounds.length,
      usage: normalized.usage,
    })),
    threadUsage: expectedThreadUsage,
  });
  return {
    recomputed: {
      rounds: combinedRounds,
      tools: combinedTools,
      evidence: recomputedEvidence,
    },
    expectedAudit: auditElloTools(combinedTools),
  };
}

function validateAgentRuntime(
  run: RunManifest,
  runtime: NonNullable<RunManifest['agentRuntime']>,
  observedModel: string,
): void {
  const agent = required(run.agent, 'agent', run);
  if (
    runtime.agentId !== agent.id ||
    runtime.kind !== agent.kind ||
    runtime.agentConfigHash !== run.job.agentConfigHash ||
    runtime.configSha256 !== run.job.agentConfigHash ||
    runtime.observedModel !== observedModel
  ) {
    throw new Error(`Agent runtime identity mismatch: ${run.attemptId}`);
  }
  switch (agent.kind) {
    case 'ello':
      if (
        runtime.kind !== 'ello' ||
        runtime.expectedModel !== agent.models[agent.primaryModel]?.apiModel ||
        runtime.primaryModel !== agent.primaryModel ||
        runtime.auxiliaryModel !== agent.auxiliaryModel
      ) {
        throw new Error(`Ello runtime provenance mismatch: ${run.attemptId}`);
      }
      break;
    case 'claude-code':
      if (
        runtime.kind !== 'claude-code' ||
        runtime.expectedModel !== agent.model ||
        runtime.expectedVersion !== agent.binary.expectedVersion ||
        runtime.executableSha256 !== agent.binary.sha256 ||
        runtime.baseUrl !== agent.connection.baseUrl ||
        runtime.apiKeyEnv !== agent.connection.apiKeyEnv ||
        (runtime.adapterContractVersion === '2' &&
          (agent.reasoningEffort === undefined ||
            runtime.reasoningEffort !== agent.reasoningEffort))
      ) {
        throw new Error(`Claude runtime provenance mismatch: ${run.attemptId}`);
      }
      break;
    case 'codex':
      if (
        runtime.kind !== 'codex' ||
        runtime.expectedModel !== agent.model ||
        runtime.expectedVersion !== agent.binary.expectedVersion ||
        runtime.executableSha256 !== agent.binary.sha256 ||
        runtime.reasoningEffort !== agent.reasoningEffort ||
        runtime.baseUrl !== agent.connection.baseUrl ||
        runtime.apiKeyEnv !== agent.connection.apiKeyEnv
      ) {
        throw new Error(`Codex runtime provenance mismatch: ${run.attemptId}`);
      }
      break;
  }
}

function validateElloRoundModels(
  agent: Extract<AgentSpec, { readonly kind: 'ello' }>,
  rounds: readonly Extract<
    BenchmarkRound,
    { readonly modelSelector: 'primary_model' | 'auxiliary_model' }
  >[],
  attemptId: string,
): void {
  for (const round of rounds) {
    const configuredModel =
      round.modelSelector === 'primary_model'
        ? agent.primaryModel
        : agent.auxiliaryModel;
    const model = agent.models[configuredModel];
    if (
      model === undefined ||
      round.configuredModel !== configuredModel ||
      round.protocol !== model.protocol ||
      round.apiModel !== model.apiModel ||
      round.agentName === ''
    ) {
      throw new Error(`Ello round model identity mismatch: ${attemptId}`);
    }
  }
}

function requireElloRounds(
  rounds: readonly BenchmarkRound[],
  attemptId: string,
): readonly Extract<
  BenchmarkRound,
  { readonly modelSelector: 'primary_model' | 'auxiliary_model' }
>[] {
  return rounds.map((round) => {
    if (!('modelSelector' in round)) {
      throw new Error(`Ello round has no model identity: ${attemptId}`);
    }
    return round;
  });
}

function parseRounds(source: string): BenchmarkRound[] {
  return source
    .split(/\r?\n/u)
    .filter((line) => line !== '')
    .map((line) => RoundSchema.parse(JSON.parse(line) as unknown));
}

function required<T>(value: T | undefined, field: string, run: RunManifest): T {
  if (value === undefined) {
    throw new Error(`Missing ${field}: ${run.attemptId}`);
  }
  return value;
}
