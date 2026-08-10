import { z } from 'zod';

export const ProcessResultSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().nonnegative(),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
  })
  .strict();

export type ProcessResult = z.infer<typeof ProcessResultSchema>;

export const ArtifactReferenceSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export const FileEvidenceSchema = ArtifactReferenceSchema.extend({
  bytes: z.number().int().nonnegative(),
}).strict();

export type FileEvidence = z.infer<typeof FileEvidenceSchema>;

export const AgentProcessArtifactSchema = z
  .object({
    schema: z.literal('ello.benchmark.agent-process.v1'),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    process: ProcessResultSchema,
    invocation: FileEvidenceSchema,
    stdout: FileEvidenceSchema,
    stderr: FileEvidenceSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.stdout.bytes !== artifact.process.stdoutBytes) {
      context.addIssue({
        code: 'custom',
        path: ['stdout', 'bytes'],
        message: 'Agent stdout byte count does not match process evidence.',
      });
    }
    if (artifact.stderr.bytes !== artifact.process.stderrBytes) {
      context.addIssue({
        code: 'custom',
        path: ['stderr', 'bytes'],
        message: 'Agent stderr byte count does not match process evidence.',
      });
    }
  });

export type AgentProcessArtifact = z.infer<typeof AgentProcessArtifactSchema>;

export const VerifierProcessArtifactSchema = z
  .object({
    schema: z.literal('ello.benchmark.verifier-process.v1'),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    process: ProcessResultSchema,
    testResults: z
      .object({
        baselineExitCode: z.number().int().nonnegative().nullable(),
        newTestsExitCode: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    storagePolicy: z
      .object({
        enforcement: z.literal('workspace-and-writable-layer-watchdog'),
        accounting: z.tuple([
          z.literal('bind-workspace-apparent-bytes'),
          z.literal('container-size-rw'),
        ]),
        limitBytes: z.number().int().positive(),
        intervalMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
    stdout: FileEvidenceSchema,
    stderr: FileEvidenceSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.stdout.bytes !== artifact.process.stdoutBytes) {
      context.addIssue({
        code: 'custom',
        path: ['stdout', 'bytes'],
        message: 'Verifier stdout byte count does not match process evidence.',
      });
    }
    if (artifact.stderr.bytes !== artifact.process.stderrBytes) {
      context.addIssue({
        code: 'custom',
        path: ['stderr', 'bytes'],
        message: 'Verifier stderr byte count does not match process evidence.',
      });
    }
  });

export type VerifierProcessArtifact = z.infer<
  typeof VerifierProcessArtifactSchema
>;

export const PhaseTimingSchema = z
  .object({
    phase: z.string().min(1),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    status: z.enum(['completed', 'failed']),
  })
  .strict();

export const PhaseTimingsArtifactSchema = z
  .object({
    schema: z.literal('ello.benchmark.phase-timings.v1'),
    phases: z.array(PhaseTimingSchema).min(1),
  })
  .strict()
  .superRefine((artifact, context) => {
    const seen = new Set<string>();
    for (const [index, timing] of artifact.phases.entries()) {
      if (seen.has(timing.phase)) {
        context.addIssue({
          code: 'custom',
          path: ['phases', index, 'phase'],
          message: `Duplicate phase timing: ${timing.phase}.`,
        });
      }
      seen.add(timing.phase);
    }
  });

export type PhaseTimingsArtifact = z.infer<typeof PhaseTimingsArtifactSchema>;

export const EventCaptureSchema = z
  .object({
    schema: z.literal('ello.benchmark.event-capture.v1'),
    sequence: z.number().int().nonnegative(),
    event: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type EventCapture = z.infer<typeof EventCaptureSchema>;

export const EventCaptureCompleteSchema = z
  .object({
    schema: z.literal('ello.benchmark.event-capture.complete.v1'),
    eventLogPath: z.string().min(1),
    eventCount: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    turnCount: z.number().int().nonnegative(),
    modelCallCount: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export type EventCaptureComplete = z.infer<typeof EventCaptureCompleteSchema>;

export const NormalizedToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.enum(['read', 'search', 'edit', 'shell', 'other']),
    status: z.enum(['completed', 'failed']),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    command: z.string().min(1).nullable(),
    paths: z.array(z.string().min(1)),
    mutating: z.boolean(),
  })
  .strict();

export type NormalizedToolCall = z.infer<typeof NormalizedToolCallSchema>;

export const CompleteUsageEvidenceSchema = z
  .object({
    status: z.literal('complete'),
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    cacheWriteTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    toolCalls: z.number().int().nonnegative(),
  })
  .strict();

export const UnavailableUsageEvidenceSchema = z
  .object({
    status: z.literal('unavailable'),
    reason: z.string().min(1),
  })
  .strict();

export const UsageEvidenceSchema = z.discriminatedUnion('status', [
  CompleteUsageEvidenceSchema,
  UnavailableUsageEvidenceSchema,
]);

export type CompleteUsageEvidence = z.infer<typeof CompleteUsageEvidenceSchema>;
export type UsageEvidence = z.infer<typeof UsageEvidenceSchema>;

export const AgentThreadEvidenceSchema = z
  .object({
    threadId: z.string().min(1),
    kind: z.enum(['main', 'subagent']),
    rawSource: FileEvidenceSchema,
    rounds: FileEvidenceSchema,
    roundCount: z.number().int().positive(),
    usage: UsageEvidenceSchema,
  })
  .strict();

export const ThreadUsageEvidenceSchema = z
  .object({
    main: UsageEvidenceSchema,
    subagents: UsageEvidenceSchema,
    combined: UsageEvidenceSchema,
  })
  .strict();

const RoundBaseShape = {
  schema: z.literal('ello.benchmark.round.v2'),
  round: z.number().int().positive(),
  requestId: z.string().min(1),
  startedAt: z.string().datetime().nullable(),
  firstTokenAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  status: z.enum(['completed', 'failed', 'incomplete']),
  finishReason: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  usage: UsageEvidenceSchema,
  toolCalls: z.array(NormalizedToolCallSchema),
  durationMs: z.number().nonnegative().nullable(),
  firstTokenLatencyMs: z.number().nonnegative().nullable(),
} as const;

const ElloRoundSchema = z
  .object({
    ...RoundBaseShape,
    agentName: z.string().min(1),
    modelSelector: z.enum(['primary_model', 'auxiliary_model']),
    configuredModel: z.string().min(1),
    protocol: z.enum(['openai', 'anthropic', 'openai-compatible']),
    apiModel: z.string().min(1),
  })
  .strict();

const ExternalRoundSchema = z
  .object({
    ...RoundBaseShape,
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();

export const RoundSchema = z.union([ElloRoundSchema, ExternalRoundSchema]);

export type BenchmarkRound = z.infer<typeof RoundSchema>;

export const ToolSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    read: z.number().int().nonnegative(),
    search: z.number().int().nonnegative(),
    edit: z.number().int().nonnegative(),
    shell: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
    timeToFirstMutationMs: z.number().nonnegative().nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.total !==
      summary.read +
        summary.search +
        summary.edit +
        summary.shell +
        summary.other
    ) {
      context.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'Tool category totals do not match total.',
      });
    }
    if (summary.failed > summary.total) {
      context.addIssue({
        code: 'custom',
        path: ['failed'],
        message: 'Failed tool count exceeds total.',
      });
    }
  });

export const NormalizedAgentEvidenceSchema = z
  .object({
    schema: z.literal('ello.benchmark.agent-evidence.v1'),
    agentId: z.string().min(1),
    kind: z.enum(['ello', 'claude-code', 'codex']),
    observedModel: z.string().min(1),
    terminalStatus: z.enum(['completed', 'failed', 'timed_out']),
    providerFailure: z.boolean(),
    parserCoverage: z.literal('complete'),
    /** Stop reason for the run as a whole; null when the Agent never reported one. */
    terminalStopReason: z.string().min(1).nullable(),
    /** Fields the Agent emitted that this framework does not consume. */
    unknownFields: z.array(z.string().min(1)),
    rawSource: FileEvidenceSchema,
    rounds: FileEvidenceSchema,
    roundCount: z.number().int().positive(),
    usage: UsageEvidenceSchema,
    tools: ToolSummarySchema,
    effectiveTools: z
      .object({
        enabled: z.tuple([z.literal('command_run')]),
        toolsetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict()
      .optional(),
    threads: z.array(AgentThreadEvidenceSchema).optional(),
    threadUsage: ThreadUsageEvidenceSchema.optional(),
  })
  .strict();

export type NormalizedAgentEvidence = z.infer<
  typeof NormalizedAgentEvidenceSchema
>;

export const ToolViolationSchema = z
  .object({
    toolCallId: z.string().min(1),
    kind: z.enum([
      'parser_incomplete',
      'path_escape',
      'network_tool',
      'unknown_mutating_tool',
    ]),
    detail: z.string().min(1),
  })
  .strict();

export type ToolViolation = z.infer<typeof ToolViolationSchema>;

export const ToolAuditSchema = z
  .object({
    schema: z.literal('ello.benchmark.tool-audit.v1'),
    status: z.enum(['passed', 'failed']),
    parserCoverage: z.enum(['complete', 'incomplete']),
    observedToolCalls: z.number().int().nonnegative(),
    shellCalls: z.number().int().nonnegative(),
    routedShellCalls: z.number().int().nonnegative(),
    fileCalls: z.number().int().nonnegative(),
    violations: z.array(ToolViolationSchema),
  })
  .strict()
  .superRefine((audit, context) => {
    const expectedStatus =
      audit.parserCoverage === 'complete' && audit.violations.length === 0
        ? 'passed'
        : 'failed';
    if (audit.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `Tool audit status must be ${expectedStatus}.`,
      });
    }
    if (audit.routedShellCalls > audit.shellCalls) {
      context.addIssue({
        code: 'custom',
        path: ['routedShellCalls'],
        message: 'Routed shell calls exceed observed shell calls.',
      });
    }
  });

export type ToolAudit = z.infer<typeof ToolAuditSchema>;

export const PatchArtifactSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().nonnegative(),
    changedFiles: z.array(z.string()),
    baselineTree: z.string().regex(/^[0-9a-f]{40,64}$/u),
  })
  .strict()
  .superRefine((artifact, context) => {
    const seen = new Set<string>();
    for (const [index, changedFile] of artifact.changedFiles.entries()) {
      if (
        pathIsInvalid(changedFile) ||
        changedFile === '.ello' ||
        changedFile.startsWith('.ello/')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['changedFiles', index],
          message: `Changed file is outside the task source contract: ${changedFile}.`,
        });
      }
      if (seen.has(changedFile)) {
        context.addIssue({
          code: 'custom',
          path: ['changedFiles', index],
          message: `Duplicate changed file: ${changedFile}.`,
        });
      }
      seen.add(changedFile);
    }
  });

export type PatchArtifact = z.infer<typeof PatchArtifactSchema>;

function pathIsInvalid(value: string): boolean {
  const segments = value.split('/');
  return (
    value.startsWith('/') ||
    value.includes('\\') ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  );
}
