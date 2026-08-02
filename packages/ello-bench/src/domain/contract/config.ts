import { z } from 'zod';

import { AgentSpecSchema } from './agent.js';

export const TaskLanguageSchema = z.enum([
  'go',
  'python',
  'typescript',
  'rust',
  'javascript',
]);
export type TaskLanguage = z.infer<typeof TaskLanguageSchema>;

export const DifficultyBandSchema = z.enum([
  'easy',
  'medium-easy',
  'medium-hard',
  'hard',
]);

export const DeepSweTaskDeclarationSchema = z
  .object({
    taskId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    language: TaskLanguageSchema,
    difficultyBand: DifficultyBandSchema,
  })
  .strict();

export const SweBenchProTaskDeclarationSchema = z
  .object({
    taskId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    instanceId: z.string().regex(/^instance_[A-Za-z0-9_.-]+$/u),
    language: TaskLanguageSchema,
    difficultyBand: DifficultyBandSchema,
  })
  .strict();

export const TaskDeclarationSchema = z.union([
  DeepSweTaskDeclarationSchema,
  SweBenchProTaskDeclarationSchema,
]);

export type DeepSweTaskDeclaration = z.infer<
  typeof DeepSweTaskDeclarationSchema
>;
export type SweBenchProTaskDeclaration = z.infer<
  typeof SweBenchProTaskDeclarationSchema
>;
export type TaskDeclaration = z.infer<typeof TaskDeclarationSchema>;

export const BenchmarkSuiteIdSchema = z.enum([
  'deep-swe-v1.1',
  'swe-bench-pro-calibration',
]);
export type BenchmarkSuiteId = z.infer<typeof BenchmarkSuiteIdSchema>;

export const BenchmarkIdSchema = z.enum([
  'ello.benchmark.deepswe.v1.1',
  'ello.benchmark.swe-bench-pro.calibration',
]);
export type BenchmarkId = z.infer<typeof BenchmarkIdSchema>;

export const BenchmarkExecutionConfigSchema = z
  .object({
    replicates: z.number().int().positive(),
    concurrency: z.number().int().positive(),
    maxInfrastructureRetries: z.number().int().min(0).max(5),
  })
  .strict();
export type BenchmarkExecutionConfig = z.infer<
  typeof BenchmarkExecutionConfigSchema
>;

export const BenchmarkReportConfigSchema = z
  .object({
    schema: z.literal('ello.benchmark.report-config.v2'),
    renderCharts: z.boolean(),
    publishability: z
      .object({
        requireCompleteMatrix: z.boolean(),
        requireCompleteUsage: z.boolean(),
        requireToolAudit: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type BenchmarkReportConfig = z.infer<typeof BenchmarkReportConfigSchema>;

export const BenchmarkContainerConfigSchema = z
  .object({
    pullPolicy: z.enum(['if-absent', 'always', 'never']),
    network: z.literal('bridge'),
    cleanup: z.enum(['always', 'on-success', 'never']),
  })
  .strict();
export type BenchmarkContainerConfig = z.infer<
  typeof BenchmarkContainerConfigSchema
>;

/** User-authored TOML configuration. Immutable suite data is code-owned. */
export const BenchmarkDefinitionSchema = z
  .object({
    schema: z.literal('ello.benchmark.config.v2'),
    suite: BenchmarkSuiteIdSchema,
    execution: BenchmarkExecutionConfigSchema,
    report: BenchmarkReportConfigSchema,
    container: BenchmarkContainerConfigSchema,
    agents: z.array(AgentSpecSchema).min(1),
  })
  .strict();
export type BenchmarkDefinition = z.infer<typeof BenchmarkDefinitionSchema>;

const BenchmarkSourceSchema = z
  .object({
    repository: z.string().url(),
    revision: z.string().regex(/^[0-9a-f]{40}$/u),
  })
  .strict();

export const BenchmarkSuiteMetadataSchema = z
  .object({
    id: BenchmarkSuiteIdSchema,
    benchmarkId: BenchmarkIdSchema,
    displayName: z.string().min(1),
    source: BenchmarkSourceSchema,
    taskSetHash: z.string().regex(/^[0-9a-f]{64}$/u),
    selectedTaskCount: z.number().int().positive(),
    upstreamTaskCount: z.number().int().positive(),
    selectionKind: z.enum(['curated', 'calibration']),
    scoreMetric: z.literal('binary-reward'),
  })
  .strict();
export type BenchmarkSuiteMetadata = z.infer<
  typeof BenchmarkSuiteMetadataSchema
>;

export const BenchmarkConfigSchema = z
  .object({
    schema: z.literal('ello.benchmark.resolved-config.v2'),
    suite: BenchmarkSuiteMetadataSchema,
    execution: BenchmarkExecutionConfigSchema,
    report: BenchmarkReportConfigSchema,
    container: BenchmarkContainerConfigSchema,
    agents: z.array(AgentSpecSchema).min(1),
    tasks: z.array(TaskDeclarationSchema).min(1),
  })
  .strict();
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

export const JobSchema = z
  .object({
    schema: z.literal('ello.benchmark.job.v2'),
    jobId: z.string().regex(/^[0-9a-f]{16}$/u),
    taskId: z.string().min(1),
    agentId: z.string().min(1),
    agentConfigHash: z.string().regex(/^[0-9a-f]{64}$/u),
    replicate: z.number().int().positive(),
  })
  .strict();

export type BenchmarkJob = z.infer<typeof JobSchema>;

const ResolvedTaskBase = {
  schema: z.literal('ello.benchmark.resolved-task.v2'),
  taskId: z.string().min(1),
  extId: z.string().min(1),
  displayTitle: z.string().min(1),
  displayDescription: z.string().min(1),
  originalTitle: z.string().min(1),
  category: z.string().min(1),
  language: TaskLanguageSchema,
  repositoryUrl: z.string().url(),
  baseCommitHash: z.string().regex(/^[0-9a-f]{7,64}$/u),
  agentTimeoutMs: z.number().int().positive(),
  verifierTimeoutMs: z.number().int().positive(),
  environment: z
    .object({
      image: z.string().min(1),
      allowInternet: z.boolean(),
      buildTimeoutMs: z.number().int().positive(),
      cpus: z.number().positive(),
      memoryMb: z.number().int().positive(),
      storageMb: z.number().int().positive(),
    })
    .strict(),
  instructionSha256: z.string().regex(/^[0-9a-f]{64}$/u),
} as const;

const DeepSweResolvedTaskSchema = z
  .object({
    ...ResolvedTaskBase,
    benchmark: z.literal('deep-swe'),
    verifierScriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    verifierPatchSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const SweBenchProResolvedTaskSchema = z
  .object({
    ...ResolvedTaskBase,
    benchmark: z.literal('swe-bench-pro'),
    workspaceSetupSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    runScriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    parserSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    testSpecSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export const ResolvedTaskSchema = z.discriminatedUnion('benchmark', [
  DeepSweResolvedTaskSchema,
  SweBenchProResolvedTaskSchema,
]);

export type ResolvedTask = z.infer<typeof ResolvedTaskSchema>;

export function validateBenchmarkDefinition(
  value: unknown,
): BenchmarkDefinition {
  const definition = BenchmarkDefinitionSchema.parse(value);
  assertUnique(
    definition.agents.map((agent) => agent.id),
    'agent id',
  );
  return definition;
}

export function validateBenchmarkConfig(value: unknown): BenchmarkConfig {
  const config = BenchmarkConfigSchema.parse(value);
  if (config.tasks.length !== config.suite.selectedTaskCount) {
    throw new Error(
      `Suite selected task count mismatch: expected ${config.suite.selectedTaskCount}, received ${config.tasks.length}.`,
    );
  }
  assertUnique(
    config.tasks.map((task) => task.taskId),
    'task id',
  );
  assertUnique(
    config.agents.map((agent) => agent.id),
    'agent id',
  );
  if (config.suite.id === 'swe-bench-pro-calibration') {
    const tasks = config.tasks.map((task) =>
      SweBenchProTaskDeclarationSchema.parse(task),
    );
    assertUnique(
      tasks.map((task) => task.instanceId),
      'SWE-bench Pro instance id',
    );
  } else {
    for (const task of config.tasks) DeepSweTaskDeclarationSchema.parse(task);
  }
  return config;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
