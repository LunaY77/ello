import path from 'node:path';

import type {
  BenchmarkConfig,
  BenchmarkJob,
  RunManifest,
} from './contracts.js';
import { createPlan } from './matrix.js';
import { collectRunProvenance } from './provenance.js';
import { openSuiteManifest, selectAttempt } from './run-state.js';
import { runBenchmarkJob } from './runner.js';
import { ensureTaskCorpus, validateCorpusTasks } from './task-corpus.js';

export interface MatrixRunResult {
  readonly runRoot: string;
  readonly completed: number;
  readonly invalid: number;
  readonly skipped: number;
  readonly retryExhausted: number;
  readonly attempts: readonly RunManifest[];
}

export async function runBenchmarkMatrix(options: {
  readonly config: BenchmarkConfig;
  readonly runRoot: string;
  readonly corpusRoot: string;
  readonly taskIds: ReadonlySet<string>;
  readonly agentIds: ReadonlySet<string>;
}): Promise<MatrixRunResult> {
  const plan = createPlan(options.config, {
    taskIds: [...options.taskIds],
    agentIds: [...options.agentIds],
  });
  const unknownTaskIds = [...options.taskIds].filter(
    (taskId) => !options.config.tasks.some((task) => task.taskId === taskId),
  );
  if (unknownTaskIds.length > 0) {
    throw new Error(`Unknown benchmark task: ${unknownTaskIds.join(', ')}.`);
  }
  const unknownAgentIds = [...options.agentIds].filter(
    (agentId) => !options.config.agents.some((agent) => agent.id === agentId),
  );
  if (unknownAgentIds.length > 0) {
    throw new Error(`Unknown benchmark Agent: ${unknownAgentIds.join(', ')}.`);
  }
  const provenance = await collectRunProvenance(
    options.config.agents.some(
      (agent) => options.agentIds.has(agent.id) && agent.kind === 'ello',
    ),
  );
  const corpusRoot = await ensureTaskCorpus({
    corpusRoot: options.corpusRoot,
    source: options.config.suite.source,
  });
  const taskFiles = await validateCorpusTasks(corpusRoot, options.config);
  const opened = await openSuiteManifest({
    runRoot: path.resolve(options.runRoot),
    config: options.config,
    plan,
  });
  const jobs = plan.jobs;
  const results: RunManifest[] = [];
  let skipped = 0;
  let retryExhausted = 0;
  const mutex = new AsyncMutex();
  let next = 0;
  const workers = Array.from(
    {
      length: Math.min(options.config.execution.concurrency, jobs.length),
    },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const job = jobs[index];
        if (job === undefined) return;
        const jobResults = await runJobWithRetries(job);
        results.push(...jobResults.attempts);
        skipped += jobResults.skipped;
        retryExhausted += jobResults.retryExhausted;
      }
    },
  );
  await Promise.all(workers);
  const jobOrder = new Map(
    plan.jobs.map((job, index) => [job.jobId, index] as const),
  );
  const orderedResults = [...results].sort((left, right) => {
    const leftIndex = jobOrder.get(left.job.jobId);
    const rightIndex = jobOrder.get(right.job.jobId);
    if (leftIndex === undefined || rightIndex === undefined) {
      throw new Error(
        'Matrix result contains a job outside the benchmark plan.',
      );
    }
    return leftIndex - rightIndex || left.attempt - right.attempt;
  });
  return {
    runRoot: path.resolve(options.runRoot),
    completed: orderedResults.filter((run) => run.status === 'completed')
      .length,
    invalid: orderedResults.filter(
      (run) => run.status === 'invalid_infrastructure',
    ).length,
    skipped,
    retryExhausted,
    attempts: orderedResults,
  };

  async function runJobWithRetries(job: BenchmarkJob): Promise<{
    readonly attempts: RunManifest[];
    readonly skipped: number;
    readonly retryExhausted: number;
  }> {
    const attempts: RunManifest[] = [];
    for (;;) {
      const selection = await mutex.run(() =>
        selectAttempt({
          suitePath: opened.path,
          suite: opened.manifest,
          job,
          maxInfrastructureRetries:
            options.config.execution.maxInfrastructureRetries,
        }),
      );
      if (selection.run === undefined) {
        return {
          attempts,
          skipped: selection.skipReason === 'completed' ? 1 : 0,
          retryExhausted: selection.skipReason === 'retry_exhausted' ? 1 : 0,
        };
      }
      const agent = options.config.agents.find(
        (candidate) => candidate.id === job.agentId,
      );
      if (agent === undefined) {
        throw new Error(`Missing Agent ${job.agentId}.`);
      }
      const files = taskFiles.get(job.taskId);
      if (files === undefined)
        throw new Error(`Missing task files ${job.taskId}.`);
      const result = await runBenchmarkJob({
        manifest: selection.run,
        agent,
        provenance,
        taskFiles: files,
        runtime: options.config.execution.runtime,
      });
      attempts.push(result);
      if (result.status === 'completed') {
        return { attempts, skipped: 0, retryExhausted: 0 };
      }
    }
  }
}

class AsyncMutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
