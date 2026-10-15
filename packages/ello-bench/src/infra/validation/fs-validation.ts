import path from 'node:path';

import {
  RunArtifactManifestSchema,
  SuiteArtifactManifestSchema,
  type RunArtifactManifest,
  type SuiteArtifactManifest,
} from '../../domain/contract/index.js';
import { stableJson } from '../../domain/hash.js';
import { readJsonFile } from '../io.js';

import { assertInside } from './artifact.js';
import { validateAttempt } from './attempt.js';
import { validatePublishedReport } from './published-report.js';

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
    SuiteArtifactManifestSchema,
  );
  if (suite.runRoot !== runRoot) {
    throw new Error(
      `Suite runRoot mismatch: ${suite.runRoot} versus ${runRoot}.`,
    );
  }
  validateAttemptMatrix(suite.jobs, suite.attempts);
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
      const run = await readJsonFile(attemptPath, RunArtifactManifestSchema);
      validateAttemptIdentity(suite, jobId, attemptPath, run);
      await validateAttempt(run, attemptPath, runRoot);
      return run;
    }),
  );
  validateRetryLineage(suite.attempts, attemptEntries, attempts);
  const hasReport = await validatePublishedReport(runRoot);
  return {
    valid: true,
    attempts: attempts.length,
    completed: attempts.filter((run) => run.status === 'completed').length,
    invalid: attempts.filter((run) => run.status === 'invalid_infrastructure')
      .length,
    report: hasReport,
  };
}

function validateAttemptMatrix(
  jobs: ReadonlyArray<{ readonly jobId: string }>,
  attempts: Readonly<Record<string, readonly string[]>>,
): void {
  const suiteJobIds = new Set(jobs.map((job) => job.jobId));
  for (const job of jobs) {
    if (!Object.hasOwn(attempts, job.jobId)) {
      throw new Error(`Suite attempts are missing job ${job.jobId}.`);
    }
  }
  for (const jobId of Object.keys(attempts)) {
    if (!suiteJobIds.has(jobId)) {
      throw new Error(`Suite attempts contain unknown job ${jobId}.`);
    }
  }
}

function validateAttemptIdentity(
  suite: SuiteArtifactManifest,
  jobId: string,
  attemptPath: string,
  run: RunArtifactManifest,
): void {
  if (run.job.jobId !== jobId) {
    throw new Error(`Attempt job mismatch: ${attemptPath}`);
  }
  if (run.configHash !== suite.configHash) {
    throw new Error(`Attempt config hash mismatch: ${attemptPath}`);
  }
  if (
    !suite.jobs.some(
      (job) => job.jobId === jobId && stableJson(job) === stableJson(run.job),
    )
  ) {
    throw new Error(`Attempt job is not in the suite matrix: ${attemptPath}`);
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
  if (run.status !== 'completed' && run.status !== 'invalid_infrastructure') {
    throw new Error(`Attempt is not terminal: ${attemptPath}`);
  }
}

function validateRetryLineage(
  attemptsByJob: Readonly<Record<string, readonly string[]>>,
  entries: ReadonlyArray<{ readonly attemptPath: string }>,
  attempts: readonly RunArtifactManifest[],
): void {
  const byPath = new Map<string, RunArtifactManifest>();
  for (const [index, entry] of entries.entries()) {
    const run = attempts[index];
    if (run === undefined) {
      throw new Error(`Missing attempt: ${entry.attemptPath}`);
    }
    byPath.set(path.resolve(entry.attemptPath), run);
  }
  for (const attemptPaths of Object.values(attemptsByJob)) {
    let previous: RunArtifactManifest | undefined;
    for (const [index, attemptPath] of attemptPaths.entries()) {
      const run = byPath.get(path.resolve(attemptPath));
      if (run === undefined) throw new Error(`Missing attempt: ${attemptPath}`);
      if (run.attempt !== index + 1) {
        throw new Error(`Attempt number mismatch: ${attemptPath}`);
      }
      if (previous !== undefined) {
        // Repair may salvage an interrupted verdict after its retry exists.
        if (
          previous.status === 'completed' &&
          !isRetryOfSalvagedAttempt(run, previous)
        ) {
          throw new Error(`Attempt follows a completed run: ${attemptPath}`);
        }
        if (
          previous.status === 'invalid_infrastructure' &&
          (run.retryOf !== previous.attemptId ||
            stableJson(run.retryReason) !== stableJson(previous.failure))
        ) {
          throw new Error(`Retry lineage mismatch: ${attemptPath}`);
        }
      }
      previous = run;
    }
  }
}

function isRetryOfSalvagedAttempt(
  run: RunArtifactManifest,
  previous: RunArtifactManifest,
): boolean {
  return (
    run.retryOf === previous.attemptId &&
    run.retryReason?.kind === 'runner' &&
    run.retryReason.phase === 'resume-interrupted-run'
  );
}
