import { z } from 'zod';

import { AgentRuntimeProvenanceSchema, AgentSpecSchema } from './agent.js';
import {
  BenchmarkReportConfigSchema,
  BenchmarkSuiteMetadataSchema,
  JobSchema,
  ResolvedTaskSchema,
} from './config.js';
import {
  ArtifactReferenceSchema,
  PatchArtifactSchema,
  ProcessResultSchema,
} from './evidence.js';

const HarnessProvenanceBase = {
  elloRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  sourceTree: z.string().regex(/^[0-9a-f]{40}$/u),
  lockfileSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  nodeVersion: z.string().min(1),
  pnpmVersion: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
} as const;

const BenchOnlyProvenanceSchema = z
  .object({
    ...HarnessProvenanceBase,
    scope: z.literal('bench-only'),
    packages: z.object({ bench: z.string().min(1) }).strict(),
  })
  .strict();

const ElloProvenanceSchema = z
  .object({
    ...HarnessProvenanceBase,
    scope: z.literal('ello'),
    packages: z
      .object({
        agent: z.string().min(1),
        tui: z.string().min(1),
        bench: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const RunProvenanceSchema = z.discriminatedUnion('scope', [
  BenchOnlyProvenanceSchema,
  ElloProvenanceSchema,
]);

export type RunProvenance = z.infer<typeof RunProvenanceSchema>;

export const HarnessReportSchema = z
  .object({
    schema: z.literal('ello.benchmark.harness.v1'),
    taskId: z.string().min(1),
    status: z.enum(['passed', 'failed']),
    reward: z.union([z.literal(0), z.literal(1)]),
    verifierProcess: ArtifactReferenceSchema,
    verifierImage: z.string().min(1),
    verifierImageId: z.string().min(1),
    modelPatchSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    appliedPatchSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    verifierCapturedPatchSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    baselineTestExitCode: z.number().int().nonnegative(),
    newTestsExitCode: z.number().int().nonnegative(),
    hiddenPatchChangedFiles: z.array(z.string().min(1)),
    patchConflictFiles: z.array(z.string().min(1)),
    reportPath: z.string().min(1),
    completedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((report, context) => {
    const expectedStatus = report.reward === 1 ? 'passed' : 'failed';
    if (report.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `Harness status must be ${expectedStatus} for reward ${report.reward}.`,
      });
    }
    if (
      report.modelPatchSha256 !== report.appliedPatchSha256 ||
      report.modelPatchSha256 !== report.verifierCapturedPatchSha256
    ) {
      context.addIssue({
        code: 'custom',
        path: ['appliedPatchSha256'],
        message: 'Harness patch checksums must match.',
      });
    }
  });

export type HarnessReport = z.infer<typeof HarnessReportSchema>;

/**
 * Records that Agent evidence could not be normalized for an otherwise valid
 * run.
 *
 * The patch was captured and the verifier scored it, so the run stays in the
 * denominator. Only the observability layer is missing: a parser defect must not
 * be able to void a completed experiment.
 */
export const EvidenceDegradationSchema = z
  .object({
    phase: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const InfrastructureFailureSchema = z
  .object({
    kind: z.enum([
      'corpus',
      'container',
      'server',
      'config',
      'provider',
      'agent_setup',
      'agent_process',
      'agent_evidence',
      'agent_environment',
      'recorder',
      'patch',
      'verifier',
      'runner',
    ]),
    phase: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export type InfrastructureFailure = z.infer<typeof InfrastructureFailureSchema>;
export type EvidenceDegradation = z.infer<typeof EvidenceDegradationSchema>;

export const RunOutcomeSchema = z.enum([
  'passed',
  'failed',
  'timeout_passed',
  'timeout_failed',
  'agent_error_passed',
  'agent_error_failed',
]);

export const RunManifestSchema = z
  .object({
    schema: z.literal('ello.benchmark.run.v2'),
    attemptId: z.string().regex(/^[0-9a-f]{24}$/u),
    attempt: z.number().int().positive(),
    retryOf: z
      .string()
      .regex(/^[0-9a-f]{24}$/u)
      .optional(),
    retryReason: InfrastructureFailureSchema.optional(),
    job: JobSchema,
    configHash: z.string().regex(/^[0-9a-f]{64}$/u),
    status: z.enum([
      'planned',
      'preparing',
      'running',
      'capturing',
      'verifying',
      'completed',
      'invalid_infrastructure',
    ]),
    phase: z.string().min(1),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    attemptRoot: z.string().min(1),
    workspace: z.string().min(1),
    agentStateRoot: z.string().min(1),
    agent: AgentSpecSchema.optional(),
    agentRuntime: AgentRuntimeProvenanceSchema.optional(),
    provenance: RunProvenanceSchema.optional(),
    task: ResolvedTaskSchema.optional(),
    imageId: z.string().min(1).optional(),
    containerName: z.string().min(1).optional(),
    baselineTree: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/u)
      .optional(),
    client: ProcessResultSchema.optional(),
    agentProcess: ArtifactReferenceSchema.optional(),
    agentEvidence: ArtifactReferenceSchema.optional(),
    toolAudit: ArtifactReferenceSchema.optional(),
    patch: PatchArtifactSchema.optional(),
    verifierProcess: ArtifactReferenceSchema.optional(),
    phaseTimingsPath: z.string().min(1).optional(),
    harness: HarnessReportSchema.optional(),
    outcome: RunOutcomeSchema.optional(),
    evidenceDegradation: EvidenceDegradationSchema.optional(),
    failure: InfrastructureFailureSchema.optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.attempt === 1 && manifest.retryOf !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['retryOf'],
        message: 'The first attempt cannot declare retryOf.',
      });
    }
    if (
      manifest.attempt > 1 &&
      (manifest.retryOf === undefined || manifest.retryReason === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['retryOf'],
        message: 'A retry requires retryOf and retryReason.',
      });
    }
    if (manifest.status === 'completed') validateCompleted(manifest, context);
    if (manifest.status === 'invalid_infrastructure') {
      validateInvalid(manifest, context);
    }
  });

export type RunManifest = z.infer<typeof RunManifestSchema>;

export const SuiteManifestSchema = z
  .object({
    schema: z.literal('ello.benchmark.suite-manifest.v3'),
    suite: BenchmarkSuiteMetadataSchema,
    report: BenchmarkReportConfigSchema,
    configHash: z.string().regex(/^[0-9a-f]{64}$/u),
    planHash: z.string().regex(/^[0-9a-f]{64}$/u),
    agents: z.array(AgentSpecSchema).min(1),
    selection: z
      .object({
        taskIds: z.array(z.string().min(1)).min(1),
        agentIds: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    runRoot: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    jobs: z.array(JobSchema).min(1),
    attempts: z.record(z.string(), z.array(z.string().min(1))),
  })
  .strict();

export type SuiteManifest = z.infer<typeof SuiteManifestSchema>;

function validateCompleted(
  manifest: z.infer<typeof RunManifestSchema>,
  context: z.RefinementCtx,
): void {
  for (const [field, value] of [
    ['startedAt', manifest.startedAt],
    ['completedAt', manifest.completedAt],
    ['task', manifest.task],
    ['agent', manifest.agent],
    ['provenance', manifest.provenance],
    ['imageId', manifest.imageId],
    ['containerName', manifest.containerName],
    ['baselineTree', manifest.baselineTree],
    ['client', manifest.client],
    ['agentProcess', manifest.agentProcess],
    ['patch', manifest.patch],
    ['verifierProcess', manifest.verifierProcess],
    ['phaseTimingsPath', manifest.phaseTimingsPath],
    ['harness', manifest.harness],
    ['outcome', manifest.outcome],
  ] as const) {
    if (value === undefined) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `Completed run requires ${field}.`,
      });
    }
  }
  // Normalized evidence exists unless this run recorded why it could not be
  // produced.
  if (manifest.evidenceDegradation === undefined) {
    for (const [field, value] of [
      ['agentRuntime', manifest.agentRuntime],
      ['agentEvidence', manifest.agentEvidence],
      ['toolAudit', manifest.toolAudit],
    ] as const) {
      if (value === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `Completed run requires ${field}.`,
        });
      }
    }
  }
  if (manifest.failure !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['failure'],
      message: 'Completed run cannot declare infrastructure failure.',
    });
  }
}

function validateInvalid(
  manifest: z.infer<typeof RunManifestSchema>,
  context: z.RefinementCtx,
): void {
  if (manifest.completedAt === undefined || manifest.failure === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['failure'],
      message: 'Invalid run requires completedAt and failure.',
    });
  }
  if (manifest.outcome !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['outcome'],
      message: 'Invalid run cannot declare a scored outcome.',
    });
  }
  if (manifest.evidenceDegradation !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceDegradation'],
      message: 'Invalid run cannot declare evidence degradation.',
    });
  }
}
