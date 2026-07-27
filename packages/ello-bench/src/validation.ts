import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentProcessExecution } from './agents/adapter.js';
import { parseClaudeCodeEvidence } from './agents/claude-code/parser.js';
import {
  aggregateUsage,
  summarizeTools,
  terminalStopReason,
} from './agents/evidence.js';
import { auditElloTools, auditExternalTools } from './agents/routing-audit.js';
import { containerShellMode } from './container-shell.js';
import {
  AgentProcessArtifactSchema,
  AgentComparisonReportSchema,
  AgentReportSchema,
  HarnessReportSchema,
  NormalizedAgentEvidenceSchema,
  PhaseTimingsArtifactSchema,
  RoundSchema,
  RunManifestSchema,
  SuiteManifestSchema,
  SuiteReportSchema,
  TaskAgentReportSchema,
  ToolAuditSchema,
  VerifierProcessArtifactSchema,
  type RunManifest,
  type NormalizedAgentEvidence,
  type ToolAudit,
  type VerifierProcessArtifact,
} from './contracts.js';
import { validateEventEvidence } from './event-evidence.js';
import { sha256, stableJson } from './hash.js';
import { readJsonFile } from './io.js';
import { calculateSuiteReport } from './report.js';
import { normalizeEventCaptureSource } from './rounds.js';

export async function validateRunRoot(runRootInput: string): Promise<{
  readonly valid: true;
  readonly attempts: number;
  readonly completed: number;
  readonly invalid: number;
  readonly report: boolean;
}> {
  const runRoot = path.resolve(runRootInput);
  const suite = await readJsonFile(
    path.join(runRoot, 'suite-manifest.json'),
    SuiteManifestSchema,
  );
  if (suite.runRoot !== runRoot) {
    throw new Error(
      `Suite runRoot mismatch: ${suite.runRoot} versus ${runRoot}.`,
    );
  }
  const suiteJobIds = new Set(suite.jobs.map((job) => job.jobId));
  for (const job of suite.jobs) {
    if (!Object.hasOwn(suite.attempts, job.jobId)) {
      throw new Error(`Suite attempts are missing job ${job.jobId}.`);
    }
  }
  for (const jobId of Object.keys(suite.attempts)) {
    if (!suiteJobIds.has(jobId)) {
      throw new Error(`Suite attempts contain unknown job ${jobId}.`);
    }
  }
  const attemptEntries = Object.entries(suite.attempts).flatMap(
    ([jobId, attemptPaths]) =>
      attemptPaths.map((attemptPath) => ({ jobId, attemptPath })),
  );
  if (
    new Set(attemptEntries.map(({ attemptPath }) => attemptPath)).size !==
    attemptEntries.length
  ) {
    throw new Error('Suite manifest contains duplicate attempt paths.');
  }
  const attempts = await Promise.all(
    attemptEntries.map(async ({ jobId, attemptPath }) => {
      assertInside(runRoot, attemptPath);
      const run = await readJsonFile(attemptPath, RunManifestSchema);
      if (run.job.jobId !== jobId) {
        throw new Error(`Attempt job mismatch: ${attemptPath}`);
      }
      if (run.configHash !== suite.configHash) {
        throw new Error(`Attempt config hash mismatch: ${attemptPath}`);
      }
      if (
        !suite.jobs.some(
          (job) =>
            job.jobId === jobId && stableJson(job) === stableJson(run.job),
        )
      ) {
        throw new Error(
          `Attempt job is not in the suite matrix: ${attemptPath}`,
        );
      }
      if (
        run.agent !== undefined &&
        !suite.agents.some(
          (agent) =>
            agent.id === run.job.agentId &&
            stableJson(agent) === stableJson(run.agent),
        )
      ) {
        throw new Error(`Attempt Agent mismatch: ${attemptPath}`);
      }
      if (
        run.status !== 'completed' &&
        run.status !== 'invalid_infrastructure'
      ) {
        throw new Error(`Attempt is not terminal: ${attemptPath}`);
      }
      await validateAttempt(run, attemptPath, runRoot);
      return run;
    }),
  );
  validateRetryLineage(suite.attempts, attemptEntries, attempts);
  const reportPath = path.join(runRoot, 'results', 'suite-report.json');
  const hasReport = await exists(reportPath);
  if (hasReport) {
    const report = await readJsonFile(reportPath, SuiteReportSchema);
    const expected = await calculateSuiteReport(runRoot, report.generatedAt);
    if (stableJson(report) !== stableJson(expected)) {
      throw new Error(
        `Suite report does not match run evidence: ${reportPath}`,
      );
    }
    for (const agent of expected.agents) {
      const agentPath = path.join(
        runRoot,
        'results',
        'agents',
        `${agent.agentId}.json`,
      );
      const publishedAgent = await readJsonFile(agentPath, AgentReportSchema);
      if (stableJson(publishedAgent) !== stableJson(agent)) {
        throw new Error(
          `Agent report does not match run evidence: ${agentPath}`,
        );
      }
      for (const task of agent.tasks) {
        const taskPath = path.join(
          runRoot,
          'results',
          'tasks',
          task.taskId,
          `${agent.agentId}.json`,
        );
        const publishedTask = await readJsonFile(
          taskPath,
          TaskAgentReportSchema,
        );
        if (stableJson(publishedTask) !== stableJson(task)) {
          throw new Error(
            `Task report does not match run evidence: ${taskPath}`,
          );
        }
      }
    }
    for (const comparison of expected.comparisons) {
      const comparisonPath = path.join(
        runRoot,
        'results',
        'comparisons',
        `${comparison.leftAgentId}-vs-${comparison.rightAgentId}.json`,
      );
      const publishedComparison = await readJsonFile(
        comparisonPath,
        AgentComparisonReportSchema,
      );
      if (stableJson(publishedComparison) !== stableJson(comparison)) {
        throw new Error(
          `Comparison report does not match run evidence: ${comparisonPath}`,
        );
      }
    }
  }
  return {
    valid: true,
    attempts: attempts.length,
    completed: attempts.filter((run) => run.status === 'completed').length,
    invalid: attempts.filter((run) => run.status === 'invalid_infrastructure')
      .length,
    report: hasReport,
  };
}

async function validateAttempt(
  run: RunManifest,
  runPath: string,
  runRoot: string,
): Promise<void> {
  const attemptRoot = path.dirname(runPath);
  if (path.resolve(run.attemptRoot) !== attemptRoot) {
    throw new Error(`Attempt root mismatch: ${run.attemptId}`);
  }
  assertInside(runRoot, run.attemptRoot);
  assertInside(run.attemptRoot, run.workspace);
  assertInside(run.attemptRoot, run.agentStateRoot);
  if (run.phaseTimingsPath !== undefined) {
    assertInside(run.attemptRoot, run.phaseTimingsPath);
    await readJsonFile(run.phaseTimingsPath, PhaseTimingsArtifactSchema);
  }
  let verifierProcessArtifact: VerifierProcessArtifact | undefined;
  if (run.verifierProcess !== undefined) {
    verifierProcessArtifact = await validateVerifierProcess(
      run.attemptRoot,
      run.verifierProcess,
      run.status === 'completed',
    );
  }
  if (run.status === 'invalid_infrastructure') return;
  const task = required(run.task, 'task', run);
  const provenance = required(run.provenance, 'provenance', run);
  if (run.agent?.kind === 'ello' && provenance.scope !== 'ello') {
    throw new Error(`Ello run requires Ello harness provenance: ${run.attemptId}`);
  }
  if (task.taskId !== run.job.taskId) {
    throw new Error(`Resolved task mismatch: ${run.attemptId}`);
  }
  const patch = required(run.patch, 'patch', run);
  assertInside(run.attemptRoot, patch.path);
  const patchContent = await readFile(patch.path);
  if (
    patchContent.byteLength !== patch.bytes ||
    sha256(patchContent) !== patch.sha256
  ) {
    throw new Error(`Patch artifact mismatch: ${patch.path}`);
  }
  const client = required(run.client, 'client', run);
  if (run.evidenceDegradation === undefined) {
    await validateAgentArtifacts(run, client);
  } else {
    // Evidence was never normalized for this run, so there is nothing to
    // recompute. The scored path below is still checked in full.
    for (const [field, value] of [
      ['agentRuntime', run.agentRuntime],
      ['agentEvidence', run.agentEvidence],
      ['toolAudit', run.toolAudit],
    ] as const) {
      if (value !== undefined) {
        throw new Error(
          `Degraded run must not declare ${field}: ${run.attemptId}`,
        );
      }
    }
  }
  const harness = required(run.harness, 'harness', run);
  if (harness.taskId !== run.job.taskId) {
    throw new Error(`Harness task mismatch: ${run.attemptId}`);
  }
  assertInside(run.attemptRoot, harness.reportPath);
  const report = await readJsonFile(harness.reportPath, HarnessReportSchema);
  if (stableJson(report) !== stableJson(harness)) {
    throw new Error(`Harness report mismatch: ${harness.reportPath}`);
  }
  if (stableJson(harness.verifierProcess) !== stableJson(run.verifierProcess)) {
    throw new Error(`Verifier process reference mismatch: ${run.attemptId}`);
  }
  if (
    verifierProcessArtifact === undefined ||
    harness.baselineTestExitCode !==
      verifierProcessArtifact.testResults.baselineExitCode ||
    harness.newTestsExitCode !==
      verifierProcessArtifact.testResults.newTestsExitCode
  ) {
    throw new Error(`Verifier test results mismatch: ${run.attemptId}`);
  }
  if (
    harness.modelPatchSha256 !== patch.sha256 ||
    harness.appliedPatchSha256 !== patch.sha256
  ) {
    throw new Error(`Harness patch checksum mismatch: ${run.attemptId}`);
  }
  const expectedOutcome = classifyOutcome(client, harness.reward);
  if (run.outcome !== expectedOutcome) {
    throw new Error(`Run outcome mismatch: ${run.attemptId}`);
  }
}

async function validateVerifierProcess(
  attemptRoot: string,
  reference: { readonly path: string; readonly sha256: string },
  requireSuccess: boolean,
): Promise<VerifierProcessArtifact> {
  assertInside(attemptRoot, reference.path);
  const artifactContent = await readFile(reference.path);
  if (sha256(artifactContent) !== reference.sha256) {
    throw new Error(`Verifier process artifact mismatch: ${reference.path}`);
  }
  const artifact = VerifierProcessArtifactSchema.parse(
    JSON.parse(artifactContent.toString('utf8')) as unknown,
  );
  for (const output of [artifact.stdout, artifact.stderr]) {
    assertInside(attemptRoot, output.path);
    const content = await readFile(output.path);
    if (
      content.byteLength !== output.bytes ||
      sha256(content) !== output.sha256
    ) {
      throw new Error(`Verifier output artifact mismatch: ${output.path}`);
    }
  }
  if (
    requireSuccess &&
    (artifact.process.timedOut ||
      artifact.process.exitCode !== 0 ||
      artifact.testResults.baselineExitCode === null ||
      artifact.testResults.newTestsExitCode === null)
  ) {
    throw new Error(
      `Completed verifier process is not successful: ${reference.path}`,
    );
  }
  return artifact;
}

async function validateAgentArtifacts(
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
  const rounds = (await readFile(evidence.rounds.path, 'utf8'))
    .split(/\r?\n/u)
    .filter((line) => line !== '')
    .map((line) => RoundSchema.parse(JSON.parse(line) as unknown));
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
    readonly rounds: readonly (typeof rounds)[number][];
    readonly tools: readonly import('./contracts.js').NormalizedToolCall[];
  };
  let expectedAudit: ToolAudit;
  switch (agent.kind) {
    case 'ello': {
      const capture = await validateEventEvidence(
        path.dirname(evidence.rawSource.path),
      );
      if (capture.eventLogPath !== evidence.rawSource.path) {
        throw new Error(`Ello event source mismatch: ${run.attemptId}`);
      }
      const normalized = normalizeEventCaptureSource(
        await readFile(evidence.rawSource.path, 'utf8'),
        client.timedOut,
      );
      const elloRounds = requireElloRounds(normalized.rounds, run.attemptId);
      validateElloRoundModels(agent, elloRounds, run.attemptId);
      const firstRound = elloRounds[0];
      if (firstRound === undefined) {
        throw new Error(`Ello observed model is missing: ${run.attemptId}`);
      }
      const observedModel = firstRound.apiModel;
      recomputed = {
        rounds: normalized.rounds,
        tools: normalized.tools,
        evidence: NormalizedAgentEvidenceSchema.parse({
          ...evidence,
          observedModel,
          terminalStatus: client.timedOut
            ? 'timed_out'
            : normalized.providerFailure
              ? 'failed'
              : 'completed',
          providerFailure: normalized.providerFailure,
          terminalStopReason: terminalStopReason(normalized.rounds),
          unknownFields: [],
          roundCount: normalized.rounds.length,
          usage: normalized.usage,
          tools: summarizeTools(normalized.rounds),
        }),
      };
      expectedAudit = auditElloTools(normalized.tools);
      break;
    }
    case 'claude-code':
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
        containerName: required(run.containerName, 'containerName', run),
        containerWorkspace: '/app',
        shellMode: containerShellMode(
          required(run.task, 'task', run).benchmark,
        ),
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
        runtime.apiKeyEnv !== agent.connection.apiKeyEnv
      ) {
        throw new Error(`Claude runtime provenance mismatch: ${run.attemptId}`);
      }
      break;
  }
}

function validateElloRoundModels(
  agent: Extract<import('./contracts.js').AgentSpec, { readonly kind: 'ello' }>,
  rounds: readonly Extract<
    import('./contracts.js').BenchmarkRound,
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
  rounds: readonly import('./contracts.js').BenchmarkRound[],
  attemptId: string,
): readonly Extract<
  import('./contracts.js').BenchmarkRound,
  { readonly modelSelector: 'primary_model' | 'auxiliary_model' }
>[] {
  return rounds.map((round) => {
    if (!('modelSelector' in round)) {
      throw new Error(`Ello round has no model identity: ${attemptId}`);
    }
    return round;
  });
}

async function readReferencedJson<
  TSchema extends { parse(value: unknown): unknown },
>(
  attemptRoot: string,
  reference: { readonly path: string; readonly sha256: string },
  schema: TSchema,
): Promise<ReturnType<TSchema['parse']>> {
  assertInside(attemptRoot, reference.path);
  const content = await readFile(reference.path);
  if (sha256(content) !== reference.sha256) {
    throw new Error(`Artifact checksum mismatch: ${reference.path}`);
  }
  return schema.parse(
    JSON.parse(content.toString('utf8')) as unknown,
  ) as ReturnType<TSchema['parse']>;
}

async function validateFileEvidence(
  attemptRoot: string,
  file: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  },
): Promise<void> {
  assertInside(attemptRoot, file.path);
  const content = await readFile(file.path);
  if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
    throw new Error(`File evidence mismatch: ${file.path}`);
  }
}

function validateRetryLineage(
  attemptsByJob: Readonly<Record<string, readonly string[]>>,
  entries: ReadonlyArray<{ readonly attemptPath: string }>,
  attempts: readonly RunManifest[],
): void {
  const byPath = new Map<string, RunManifest>();
  for (const [index, entry] of entries.entries()) {
    const run = attempts[index];
    if (run === undefined)
      throw new Error(`Missing attempt: ${entry.attemptPath}`);
    byPath.set(path.resolve(entry.attemptPath), run);
  }
  for (const attemptPaths of Object.values(attemptsByJob)) {
    let previous: RunManifest | undefined;
    for (const [index, attemptPath] of attemptPaths.entries()) {
      const run = byPath.get(path.resolve(attemptPath));
      if (run === undefined) throw new Error(`Missing attempt: ${attemptPath}`);
      if (run.attempt !== index + 1) {
        throw new Error(`Attempt number mismatch: ${attemptPath}`);
      }
      if (previous !== undefined) {
        if (previous.status !== 'invalid_infrastructure') {
          throw new Error(`Attempt follows a completed run: ${attemptPath}`);
        }
        if (
          run.retryOf !== previous.attemptId ||
          stableJson(run.retryReason) !== stableJson(previous.failure)
        ) {
          throw new Error(`Retry lineage mismatch: ${attemptPath}`);
        }
      }
      previous = run;
    }
  }
}

function classifyOutcome(
  client: NonNullable<RunManifest['client']>,
  reward: 0 | 1,
): NonNullable<RunManifest['outcome']> {
  if (client.timedOut)
    return reward === 1 ? 'timeout_passed' : 'timeout_failed';
  if (client.exitCode === 0) return reward === 1 ? 'passed' : 'failed';
  return reward === 1 ? 'agent_error_passed' : 'agent_error_failed';
}

function required<T>(value: T | undefined, field: string, run: RunManifest): T {
  if (value === undefined)
    throw new Error(`Missing ${field}: ${run.attemptId}`);
  return value;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, path.resolve(target));
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Attempt path escapes run root: ${target}`);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}
