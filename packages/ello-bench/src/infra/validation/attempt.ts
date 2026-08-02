import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  HarnessReportSchema,
  PhaseTimingsArtifactSchema,
  VerifierProcessArtifactSchema,
  type RunManifest,
  type VerifierProcessArtifact,
} from '../../domain/contract/index.js';
import { sha256, stableJson } from '../../domain/hash.js';
import { readJsonFile } from '../io.js';

import { validateAgentArtifacts } from './agent-artifacts.js';
import { assertInside } from './artifact.js';

export async function validateAttempt(
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
  if (run.outcome !== classifyOutcome(client, harness.reward)) {
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

function classifyOutcome(
  client: NonNullable<RunManifest['client']>,
  reward: 0 | 1,
): NonNullable<RunManifest['outcome']> {
  if (client.timedOut) {
    return reward === 1 ? 'timeout_passed' : 'timeout_failed';
  }
  if (client.exitCode === 0) return reward === 1 ? 'passed' : 'failed';
  return reward === 1 ? 'agent_error_passed' : 'agent_error_failed';
}

function required<T>(value: T | undefined, field: string, run: RunManifest): T {
  if (value === undefined) {
    throw new Error(`Missing ${field}: ${run.attemptId}`);
  }
  return value;
}
