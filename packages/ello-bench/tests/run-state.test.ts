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
});
