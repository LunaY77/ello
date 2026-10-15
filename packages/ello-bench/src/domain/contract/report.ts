import { z } from 'zod';

import {
  BenchmarkReportConfigSchema,
  BenchmarkSuiteMetadataSchema,
} from './config.js';
import { InfrastructureFailureSchema } from './run.js';

export const DistributionSchema = z
  .object({
    count: z.number().int().nonnegative(),
    mean: z.number().nonnegative().nullable().optional(),
    median: z.number().nonnegative().nullable(),
    p95: z.number().nonnegative().nullable(),
  })
  .strict();

const ResourceDistributionFields = {
  elapsedMs: DistributionSchema,
  rounds: DistributionSchema,
  toolCalls: DistributionSchema,
  inputTokens: DistributionSchema,
  nonCachedInputTokens: DistributionSchema.optional(),
  outputTokens: DistributionSchema,
  cacheReadTokens: DistributionSchema,
  cacheWriteTokens: DistributionSchema,
  cacheHitRate: DistributionSchema.optional(),
  reasoningTokens: DistributionSchema.optional(),
} as const;

const TaskResourcesSchema = z.object(ResourceDistributionFields).strict();

const AgentResourcesSchema = z
  .object({
    ...ResourceDistributionFields,
    phaseElapsedMs: z.record(z.string().min(1), DistributionSchema),
    threadUsage: z
      .object({
        mainInputTokens: DistributionSchema,
        subagentInputTokens: DistributionSchema,
        combinedInputTokens: DistributionSchema,
        mainOutputTokens: DistributionSchema,
        subagentOutputTokens: DistributionSchema,
        combinedOutputTokens: DistributionSchema,
        mainToolCalls: DistributionSchema,
        subagentToolCalls: DistributionSchema,
        combinedToolCalls: DistributionSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const TaskAgentReportSchema = z
  .object({
    taskId: z.string().min(1),
    agentId: z.string().min(1),
    validRuns: z.number().int().nonnegative(),
    passedRuns: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1).nullable(),
    resources: TaskResourcesSchema.optional(),
  })
  .strict();

export const EvidenceCoverageSchema = z
  .object({
    usageCompleteRuns: z.number().int().nonnegative(),
    usageUnavailableRuns: z.number().int().nonnegative(),
    toolAuditPassedRuns: z.number().int().nonnegative(),
  })
  .strict();

export const AgentReportSchema = z
  .object({
    agentId: z.string().min(1),
    agentConfigHash: z.string().regex(/^[0-9a-f]{64}$/u),
    validRuns: z.number().int().nonnegative(),
    passedRuns: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1).nullable(),
    invalidRuns: z.number().int().nonnegative(),
    taskMacroAverage: z.number().min(0).max(1).nullable(),
    tasks: z.array(TaskAgentReportSchema),
    resources: AgentResourcesSchema,
    evidenceCoverage: EvidenceCoverageSchema,
  })
  .strict();

export const AgentComparisonReportSchema = z
  .object({
    leftAgentId: z.string().min(1),
    rightAgentId: z.string().min(1),
    matchedRuns: z.number().int().nonnegative(),
    excludedPairs: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    pairedPassRateDelta: z.number().min(-1).max(1).nullable(),
    taskMacroDelta: z.number().min(-1).max(1).nullable(),
    durationRatio: DistributionSchema.nullable(),
    inputTokenRatio: DistributionSchema.nullable(),
    outputTokenRatio: DistributionSchema.nullable(),
    toolCallRatio: DistributionSchema.nullable(),
    resourceCoverage: z
      .object({
        durationPairs: z.number().int().nonnegative(),
        inputTokenPairs: z.number().int().nonnegative(),
        outputTokenPairs: z.number().int().nonnegative(),
        toolCallPairs: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const SuiteReportSchema = z
  .object({
    schema: z.literal('ello.benchmark.suite.v3'),
    suite: BenchmarkSuiteMetadataSchema,
    reportConfig: BenchmarkReportConfigSchema,
    configHash: z.string().regex(/^[0-9a-f]{64}$/u),
    planHash: z.string().regex(/^[0-9a-f]{64}$/u),
    generatedAt: z.string().datetime(),
    plannedJobs: z.number().int().positive(),
    scoredJobs: z.number().int().nonnegative(),
    invalidJobs: z.number().int().nonnegative(),
    publishable: z.boolean(),
    agents: z.array(AgentReportSchema).min(1),
    comparisons: z.array(AgentComparisonReportSchema),
    invalidLedger: z.array(
      z
        .object({
          attemptId: z.string().regex(/^[0-9a-f]{24}$/u),
          jobId: z.string().regex(/^[0-9a-f]{16}$/u),
          taskId: z.string().min(1),
          agentId: z.string().min(1),
          failure: InfrastructureFailureSchema,
          partialEvidence: z
            .object({
              elapsedMs: z.number().nonnegative(),
              rounds: z
                .object({
                  observed: z.number().int().nonnegative(),
                  completed: z.number().int().nonnegative(),
                  failed: z.number().int().nonnegative(),
                  incomplete: z.number().int().nonnegative(),
                })
                .strict(),
              tools: z
                .object({
                  observed: z.number().int().nonnegative(),
                  failed: z.number().int().nonnegative(),
                })
                .strict(),
              usage: z
                .object({
                  completeRounds: z.number().int().nonnegative(),
                  unavailableRounds: z.number().int().nonnegative(),
                  inputTokens: z.number().int().nonnegative(),
                  outputTokens: z.number().int().nonnegative(),
                  cacheReadTokens: z.number().int().nonnegative().nullable(),
                  cacheWriteTokens: z.number().int().nonnegative().nullable(),
                })
                .strict(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type TaskAgentReport = z.infer<typeof TaskAgentReportSchema>;
export type AgentReport = z.infer<typeof AgentReportSchema>;
export type AgentComparisonReport = z.infer<typeof AgentComparisonReportSchema>;
export type SuiteReport = z.infer<typeof SuiteReportSchema>;
