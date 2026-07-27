/**
 * 将固定任务、Agent 和 replicate 展开为可复现 job 矩阵。
 *
 * job identity 由完整声明 hash 生成；顺序由配置文件和任务声明顺序决定。
 */
import {
  JobSchema,
  type BenchmarkConfig,
  type BenchmarkJob,
} from './contracts.js';
import { sha256, stableJson } from './hash.js';

export interface BenchmarkPlan {
  readonly schema: 'ello.benchmark.plan.v2';
  readonly benchmarkId: BenchmarkConfig['suite']['benchmarkId'];
  readonly configHash: string;
  readonly planHash: string;
  readonly selection: {
    readonly taskIds: readonly string[];
    readonly agentIds: readonly string[];
  };
  readonly jobs: ReadonlyArray<BenchmarkJob>;
}

export interface BenchmarkSelection {
  readonly taskIds: readonly string[];
  readonly agentIds: readonly string[];
}

export function expandJobs(
  config: BenchmarkConfig,
  selection: BenchmarkSelection,
): ReadonlyArray<BenchmarkJob> {
  assertSelection(config, selection);
  const selectedTasks = new Set(selection.taskIds);
  const selectedAgents = new Set(selection.agentIds);
  const jobs: BenchmarkJob[] = [];
  for (const task of config.tasks) {
    if (!selectedTasks.has(task.taskId)) continue;
    for (const agent of config.agents) {
      if (!selectedAgents.has(agent.id)) continue;
      const agentConfigHash = sha256(stableJson(agent));
      for (
        let replicate = 1;
        replicate <= config.execution.replicates;
        replicate += 1
      ) {
        const identity = {
          benchmarkId: config.suite.benchmarkId,
          sourceRevision: config.suite.source.revision,
          taskId: task.taskId,
          agentId: agent.id,
          agentConfigHash,
          replicate,
        };
        const job = JobSchema.parse({
          schema: 'ello.benchmark.job.v2',
          jobId: sha256(stableJson(identity)).slice(0, 16),
          taskId: task.taskId,
          agentId: agent.id,
          agentConfigHash,
          replicate,
        });
        jobs.push(job);
      }
    }
  }
  return jobs;
}

export function createPlan(
  config: BenchmarkConfig,
  selection: BenchmarkSelection,
): BenchmarkPlan {
  const jobs = expandJobs(config, selection);
  const normalizedSelection = {
    taskIds: config.tasks
      .map((task) => task.taskId)
      .filter((taskId) => selection.taskIds.includes(taskId)),
    agentIds: config.agents
      .map((agent) => agent.id)
      .filter((agentId) => selection.agentIds.includes(agentId)),
  };
  const planIdentity = {
    configHash: sha256(stableJson(config)),
    selection: normalizedSelection,
    jobs,
  };
  return {
    schema: 'ello.benchmark.plan.v2',
    benchmarkId: config.suite.benchmarkId,
    configHash: planIdentity.configHash,
    planHash: sha256(stableJson(planIdentity)),
    selection: normalizedSelection,
    jobs,
  };
}

export function selectAll(config: BenchmarkConfig): BenchmarkSelection {
  return {
    taskIds: config.tasks.map((task) => task.taskId),
    agentIds: config.agents.map((agent) => agent.id),
  };
}

function assertSelection(
  config: BenchmarkConfig,
  selection: BenchmarkSelection,
): void {
  assertUniqueSelection(selection.taskIds, 'task');
  assertUniqueSelection(selection.agentIds, 'agent');
  if (selection.taskIds.length === 0) {
    throw new Error('Benchmark selection requires at least one task.');
  }
  if (selection.agentIds.length === 0) {
    throw new Error('Benchmark selection requires at least one Agent.');
  }
  const taskIds = new Set(config.tasks.map((task) => task.taskId));
  const agentIds = new Set(config.agents.map((agent) => agent.id));
  for (const taskId of selection.taskIds) {
    if (!taskIds.has(taskId)) throw new Error(`Unknown task id: ${taskId}`);
  }
  for (const agentId of selection.agentIds) {
    if (!agentIds.has(agentId)) throw new Error(`Unknown Agent id: ${agentId}`);
  }
}

function assertUniqueSelection(
  values: readonly string[],
  subject: string,
): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Benchmark selection contains duplicate ${subject} ids.`);
  }
}
