import { describe, expect, it } from 'vitest';

import { BenchmarkExecutionConfigSchema } from '../src/domain/contract/index.js';
import { sha256, stableJson } from '../src/domain/hash.js';
import {
  DEEP_SWE_SOURCE_REPOSITORY,
  DEEP_SWE_TASK_SET_HASH,
  DEEP_SWE_TASKS,
} from '../src/domain/suite/deep-swe.js';
import { createPlan, expandJobs, selectAll } from '../src/domain/suite/plan.js';
import {
  SWE_BENCH_PRO_SOURCE_REPOSITORY,
  SWE_BENCH_PRO_TASK_SET_HASH,
  SWE_BENCH_PRO_TASKS,
} from '../src/domain/suite/swe-bench-pro.js';
import { loadBenchmarkConfig } from '../src/infra/config/toml-loader.js';

import {
  EXAMPLE_CONFIG_PATH,
  SWE_BENCH_PRO_EXAMPLE_CONFIG_PATH,
} from './example-config.js';

describe('benchmark matrix', () => {
  it('does not expose a selectable runtime in v2 execution config', () => {
    const execution = BenchmarkExecutionConfigSchema.parse({
      replicates: 1,
      concurrency: 1,
      maxInfrastructureRetries: 1,
    });

    expect(execution).not.toHaveProperty('runtime');
    expect(() =>
      BenchmarkExecutionConfigSchema.parse({ ...execution, runtime: 'local' }),
    ).toThrow();
  });

  it('uses the fixed twenty-task declaration in the example config', async () => {
    const config = await loadBenchmarkConfig(EXAMPLE_CONFIG_PATH);

    expect(config.suite.source.repository).toBe(DEEP_SWE_SOURCE_REPOSITORY);
    expect(config.execution).not.toHaveProperty('runtime');
    expect(config.container).toEqual({
      pullPolicy: 'if-absent',
      network: 'bridge',
      cleanup: 'always',
    });
    expect(config.tasks).toEqual(DEEP_SWE_TASKS);
    expect(config.agents).toContainEqual(
      expect.objectContaining({
        id: 'claude-code',
        reasoningEffort: 'max',
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
    expect(config.tasks.map((task) => task.taskId)).toEqual(
      expect.arrayContaining([
        'cattrs-partial-structuring-recovery',
        'httpx-streaming-json-iteration',
      ]),
    );
    expect(config.tasks.map((task) => task.taskId)).not.toEqual(
      expect.arrayContaining([
        'narwhals-rolling-window-suite',
        'langchain-request-coalescing',
      ]),
    );
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
