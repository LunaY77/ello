import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPlan, selectAll } from '../src/domain/suite/plan.js';
import { loadBenchmarkConfig } from '../src/infra/config/toml-loader.js';
import {
  invalidateRun,
  openSuiteManifest,
  selectAttempt,
  transitionRun,
} from '../src/infra/run-state.js';

import { EXAMPLE_CONFIG_PATH } from './example-config.js';

describe('run state', () => {
  it('isolates attempt identities across run roots', async () => {
    const config = await loadBenchmarkConfig(EXAMPLE_CONFIG_PATH);
    const plan = createPlan(config, selectAll(config));
    const firstRoot = await mkdtemp(path.join(tmpdir(), 'ello-bench-state-a-'));
    const secondRoot = await mkdtemp(
      path.join(tmpdir(), 'ello-bench-state-b-'),
    );
    const firstSuite = await openSuiteManifest({
      runRoot: firstRoot,
      config,
      plan,
    });
    const secondSuite = await openSuiteManifest({
      runRoot: secondRoot,
      config,
      plan,
    });
    const job = plan.jobs[0];
    if (job === undefined) throw new Error('Missing planned job.');

    const first = await selectAttempt({
      suitePath: firstSuite.path,
      suite: firstSuite.manifest,
      job,
      maxInfrastructureRetries: 1,
    });
    const second = await selectAttempt({
      suitePath: secondSuite.path,
      suite: secondSuite.manifest,
      job,
      maxInfrastructureRetries: 1,
    });

    expect(first.run?.attemptId).toBeDefined();
    expect(second.run?.attemptId).toBeDefined();
    expect(first.run?.attemptId).not.toBe(second.run?.attemptId);
  });

  it('records explicit retry lineage for an infrastructure failure', async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), 'ello-bench-state-'));
    const config = await loadBenchmarkConfig(EXAMPLE_CONFIG_PATH);
    const plan = createPlan(config, selectAll(config));
    const opened = await openSuiteManifest({ runRoot, config, plan });
    const job = plan.jobs[0];
    if (job === undefined) throw new Error('Missing planned job.');
    const first = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 1,
    });
    if (first.run === undefined) throw new Error('Missing first attempt.');
    const preparing = await transitionRun(first.run, 'preparing', {
      phase: 'prepare',
      startedAt: new Date().toISOString(),
    });
    const invalid = await invalidateRun(preparing, {
      kind: 'container',
      phase: 'prepare',
      message: 'container failed',
    });
    expect(invalid.status).toBe('invalid_infrastructure');

    const retry = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 1,
    });
    expect(retry.run).toMatchObject({
      attempt: 2,
      retryOf: invalid.attemptId,
      retryReason: invalid.failure,
    });
  });

  it('does not create attempt 2 when infrastructure retries are disabled', async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), 'ello-bench-no-retry-'));
    const config = await loadBenchmarkConfig(EXAMPLE_CONFIG_PATH);
    const plan = createPlan(config, selectAll(config));
    const opened = await openSuiteManifest({ runRoot, config, plan });
    const job = plan.jobs[0];
    if (job === undefined) throw new Error('Missing planned job.');
    const first = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 0,
    });
    if (first.run === undefined) throw new Error('Missing first attempt.');
    const invalid = await invalidateRun(first.run, {
      kind: 'container',
      phase: 'prepare',
      message: 'container failed',
    });

    const next = await selectAttempt({
      suitePath: opened.path,
      suite: opened.manifest,
      job,
      maxInfrastructureRetries: 0,
    });

    expect(invalid.attempt).toBe(1);
    expect(next).toEqual({ skipReason: 'retry_exhausted' });
    expect(opened.manifest.attempts[job.jobId]).toHaveLength(1);
  });
});
