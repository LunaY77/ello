import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  HarnessReportSchema,
  PhaseTimingsArtifactSchema,
  VerifierProcessArtifactSchema,
  type RunArtifactManifest,
  type VerifierProcessArtifact,
} from '../../domain/contract/index.js';
import { sha256, stableJson } from '../../domain/hash.js';
import { classifyDeliveryOutcome } from '../../domain/scoring/attempt-outcome.js';
import { readJsonFile } from '../io.js';

import { validateAgentArtifacts } from './agent-artifacts.js';
import { assertInside } from './artifact.js';

export async function validateAttempt(
  run: RunArtifactManifest,
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
  let baselinePreflightArtifact: VerifierProcessArtifact | undefined;
  if (run.baselinePreflightProcess !== undefined) {
    baselinePreflightArtifact = await validateVerifierProcess(
      run.attemptRoot,
      run.baselinePreflightProcess,
      'baseline-only',
    );
    if (
      run.baselinePreflightExitCode !==
      baselinePreflightArtifact.testResults.baselineExitCode
    ) {
      throw new Error(`Baseline preflight result mismatch: ${run.attemptId}`);
    }
  }
  if (run.verifierProcess !== undefined) {
    verifierProcessArtifact = await validateVerifierProcess(
      run.attemptRoot,
      run.verifierProcess,
      run.status === 'completed' ? 'full' : 'none',
    );
  }
  if (run.status === 'invalid_infrastructure') return;
  const task = required(run.task, 'task', run);
  const provenance = required(run.provenance, 'provenance', run);
  if (run.agent?.kind === 'ello' && provenance.scope !== 'ello') {
    throw new Error(
      `Ello run requires Ello harness provenance: ${run.attemptId}`,
    );
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
    // Evidence was never normalized, so no normalized artifacts may survive.
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
  if (harness.verifierRuntime !== run.executionRuntime) {
    throw new Error(`Verifier runtime mismatch: ${run.attemptId}`);
  }
  assertInside(run.attemptRoot, harness.reportPath);
  const report = await readJsonFile(harness.reportPath, HarnessReportSchema);
  if (stableJson(report) !== stableJson(harness)) {
    throw new Error(`Harness report mismatch: ${harness.reportPath}`);
  }
  if (stableJson(harness.verifierProcess) !== stableJson(run.verifierProcess)) {
    throw new Error(`Verifier process reference mismatch: ${run.attemptId}`);
  }
  const hasBaselinePreflight =
    run.baselinePreflightProcess !== undefined ||
    run.baselinePreflightExitCode !== undefined ||
    harness.baselinePreflightProcess !== undefined ||
    harness.baselinePreflightExitCode !== undefined;
  if (hasBaselinePreflight) {
    if (
      stableJson(harness.baselinePreflightProcess) !==
        stableJson(run.baselinePreflightProcess) ||
      harness.baselinePreflightExitCode !== run.baselinePreflightExitCode ||
      baselinePreflightArtifact === undefined ||
      harness.baselinePreflightExitCode !==
        baselinePreflightArtifact.testResults.baselineExitCode
    ) {
      throw new Error(`Baseline preflight evidence mismatch: ${run.attemptId}`);
    }
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
  if (
    run.outcome !==
    (isLegacyDeliveryArtifact(run)
      ? classifyLegacyOutcome(client, harness.reward)
      : classifyDeliveryOutcome({
          process: client,
          reward: harness.reward,
          patch,
        }))
  ) {
    throw new Error(`Run outcome mismatch: ${run.attemptId}`);
  }
}

function isLegacyDeliveryArtifact(run: RunArtifactManifest): boolean {
  return run.baselinePreflightProcess === undefined;
}

function classifyLegacyOutcome(
  process: NonNullable<RunArtifactManifest['client']>,
  reward: 0 | 1,
): NonNullable<RunArtifactManifest['outcome']> {
  if (process.timedOut)
    return reward === 1 ? 'timeout_passed' : 'timeout_failed';
  if (process.exitCode === 0) return reward === 1 ? 'passed' : 'failed';
  return reward === 1 ? 'agent_error_passed' : 'agent_error_failed';
}

async function validateVerifierProcess(
  attemptRoot: string,
  reference: { readonly path: string; readonly sha256: string },
  mode: 'none' | 'baseline-only' | 'full',
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
  const missingRequiredResults =
    artifact.testResults.baselineExitCode === null ||
    (mode === 'full' && artifact.testResults.newTestsExitCode === null);
  if (
    mode !== 'none' &&
    (artifact.process.timedOut ||
      artifact.process.exitCode !== 0 ||
      missingRequiredResults)
  ) {
    throw new Error(
      `Completed verifier process is not successful: ${reference.path}`,
    );
  }
  return artifact;
}

function required<T>(
  value: T | undefined,
  field: string,
  run: RunArtifactManifest,
): T {
  if (value === undefined) {
    throw new Error(`Missing ${field}: ${run.attemptId}`);
  }
  return value;
}
