import { describe, expect, it } from 'vitest';

import { loadBenchmarkConfig } from '../src/config.js';
import { BenchmarkExecutionConfigSchema } from '../src/contracts.js';
import { sha256, stableJson } from '../src/hash.js';
import { createPlan, expandJobs, selectAll } from '../src/matrix.js';
import {
  SWE_BENCH_PRO_SOURCE_REPOSITORY,
  SWE_BENCH_PRO_TASK_SET_HASH,
  SWE_BENCH_PRO_TASKS,
} from '../src/swe-bench-pro-tasks.js';
import {
  DEEP_SWE_SOURCE_REPOSITORY,
  DEEP_SWE_TASK_SET_HASH,
  DEEP_SWE_TASKS,
} from '../src/tasks.js';

import {
  EXAMPLE_CONFIG_PATH,
  SWE_BENCH_PRO_EXAMPLE_CONFIG_PATH,
} from './example-config.js';

describe('benchmark matrix', () => {
  it('keeps Docker as the default for legacy configs', () => {
    expect(
      BenchmarkExecutionConfigSchema.parse({
        replicates: 1,
        concurrency: 1,
        maxInfrastructureRetries: 1,
      }).runtime,
    ).toBe('docker');
  });

  it('uses the fixed twenty-task declaration in the example config', async () => {
    const config = await loadBenchmarkConfig(EXAMPLE_CONFIG_PATH);

    expect(config.suite.source.repository).toBe(DEEP_SWE_SOURCE_REPOSITORY);
    expect(config.execution.runtime).toBe('docker');
    expect(config.tasks).toEqual(DEEP_SWE_TASKS);
    expect(config.agents).toContainEqual(
      expect.objectContaining({
        id: 'claude-code',
        connection: expect.objectContaining({
          apiKeyEnv: 'ELLO_BENCH_API_KEY',
        }),
      }),
    );
    expect(config.agents).toContainEqual(
      expect.objectContaining({
        id: 'codex',
        reasoningEffort: 'high',
        connection: expect.objectContaining({
          apiKeyEnv: 'ELLO_BENCH_API_KEY',
        }),
      }),
    );
    expect(config.suite.taskSetHash).toBe(DEEP_SWE_TASK_SET_HASH);
    expect(DEEP_SWE_TASK_SET_HASH).toBe(sha256(stableJson(DEEP_SWE_TASKS)));
    expect(config.tasks).toHaveLength(20);
    expect(new Set(config.tasks.map((task) => task.taskId))).toHaveLength(20);
  });

  it('loads the fixed thirty-task SWE-bench Pro declaration', async () => {
    const config = await loadBenchmarkConfig(SWE_BENCH_PRO_EXAMPLE_CONFIG_PATH);

    expect(config.suite.benchmarkId).toBe(
      'ello.benchmark.swe-bench-pro.calibration',
    );
    expect(config.suite.source.repository).toBe(
      SWE_BENCH_PRO_SOURCE_REPOSITORY,
    );
    expect(config.tasks).toEqual(SWE_BENCH_PRO_TASKS);
    expect(config.suite.taskSetHash).toBe(SWE_BENCH_PRO_TASK_SET_HASH);
    expect(SWE_BENCH_PRO_TASK_SET_HASH).toBe(
      sha256(stableJson(SWE_BENCH_PRO_TASKS)),
    );
    expect(config.tasks).toHaveLength(30);
    expect(config.suite.upstreamTaskCount).toBe(731);
    expect(new Set(config.tasks.map((task) => task.instanceId))).toHaveLength(
      30,
    );
    expect(
      config.tasks.reduce<Record<string, number>>((counts, task) => {
        const group =
          task.language === 'typescript' || task.language === 'javascript'
            ? 'typescript/javascript'
            : task.language;
        counts[group] = (counts[group] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ python: 10, 'typescript/javascript': 10, go: 10 });
    expect(
      config.tasks.reduce<Record<string, number>>((counts, task) => {
        counts[task.difficultyBand] = (counts[task.difficultyBand] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ easy: 8, 'medium-easy': 7, 'medium-hard': 8, hard: 7 });
  });

  it('expands stable job identities for every task and replicate', async () => {
    const config = await loadBenchmarkConfig(EXAMPLE_CONFIG_PATH);
    const selection = selectAll(config);
    const first = createPlan(config, selection);
    const second = createPlan(config, selection);

    expect(first).toEqual(second);
    expect(first.jobs).toHaveLength(60);
    expect(new Set(first.jobs.map((job) => job.jobId))).toHaveLength(60);
    expect(expandJobs(config, selection)).toHaveLength(60);
    expect(new Set(first.jobs.map((job) => job.agentId))).toEqual(
      new Set(config.agents.map((agent) => agent.id)),
    );
  });
});
