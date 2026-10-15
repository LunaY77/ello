import { z } from 'zod';

export const AgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

export const ReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const ModelReasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const HttpHeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const HttpHeaderValueSchema = z
  .string()
  .min(1)
  .regex(/^[^\r\n]+$/u);
const HttpHeadersSchema = z.record(HttpHeaderNameSchema, HttpHeaderValueSchema);

const BenchmarkModelFields = {
  apiModel: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
  httpHeaders: HttpHeadersSchema.optional(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  reasoningEffort: ModelReasoningEffortSchema,
};

const AnthropicAuthSchemeSchema = z.enum(['api-key', 'bearer']);

export const BenchmarkModelSchema = z
  .discriminatedUnion('protocol', [
    z
      .object({
        protocol: z.literal('openai'),
        endpoint: z.enum(['responses', 'chat']),
        ...BenchmarkModelFields,
      })
      .strict(),
    z
      .object({
        protocol: z.literal('anthropic'),
        authScheme: AnthropicAuthSchemeSchema,
        ...BenchmarkModelFields,
      })
      .strict(),
    z
      .object({
        protocol: z.literal('openai-compatible'),
        endpoint: z.enum(['responses', 'chat']),
        ...BenchmarkModelFields,
      })
      .strict(),
  ])
  .superRefine((model, context) => {
    if (model.maxOutputTokens > model.contextWindow) {
      context.addIssue({
        code: 'custom',
        path: ['maxOutputTokens'],
        message: 'must not exceed contextWindow.',
      });
    }
    if (model.httpHeaders === undefined) return;

    const reservedHeader =
      model.protocol === 'anthropic' && model.authScheme === 'api-key'
        ? 'x-api-key'
        : 'authorization';
    const seen = new Set<string>();
    for (const headerName of Object.keys(model.httpHeaders)) {
      const normalizedName = headerName.toLowerCase();
      if (seen.has(normalizedName)) {
        context.addIssue({
          code: 'custom',
          path: ['httpHeaders', headerName],
          message: 'must not repeat a header name case-insensitively',
        });
      }
      seen.add(normalizedName);
      if (normalizedName === reservedHeader) {
        context.addIssue({
          code: 'custom',
          path: ['httpHeaders', headerName],
          message: `must not override provider authentication header ${reservedHeader}`,
        });
      }
    }
  });

const AgentSpecBase = {
  id: AgentIdSchema,
  displayName: z.string().min(1),
} as const;

export const AgentFeaturesSchema = z
  .object({
    subagents: z.boolean(),
  })
  .strict();
export type AgentFeatures = z.infer<typeof AgentFeaturesSchema>;

export const ElloPromptModeSchema = z.enum(['rapid', 'thorough']);
export type ElloPromptMode = z.infer<typeof ElloPromptModeSchema>;

export const ElloAgentSpecSchema = z
  .object({
    ...AgentSpecBase,
    kind: z.literal('ello'),
    models: z.record(z.string().min(1), BenchmarkModelSchema),
    primaryModel: z.string().min(1),
    auxiliaryModel: z.string().min(1),
    promptMode: ElloPromptModeSchema.default('rapid'),
    features: AgentFeaturesSchema.default({ subagents: true }),
  })
  .strict()
  .superRefine((agent, context) => {
    for (const field of ['primaryModel', 'auxiliaryModel'] as const) {
      if (agent.models[agent[field]] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `references unknown model: ${agent[field]}.`,
        });
      }
    }
  });

export const AgentBinarySchema = z
  .object({
    pathEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    expectedVersion: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export const ClaudeCodeAgentSpecSchema = z
  .object({
    ...AgentSpecBase,
    kind: z.literal('claude-code'),
    model: z.string().min(1),
    // v1 run artifacts predate explicit Claude effort provenance. New TOML
    // configs still require this field at the raw-config boundary.
    reasoningEffort: ModelReasoningEffortSchema.optional(),
    binary: AgentBinarySchema,
    connection: z
      .object({
        baseUrl: z.string().url(),
        apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
        httpHeaders: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    environment: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const CodexAgentSpecSchema = z
  .object({
    ...AgentSpecBase,
    kind: z.literal('codex'),
    model: z.string().min(1),
    reasoningEffort: ReasoningEffortSchema,
    binary: AgentBinarySchema,
    connection: z
      .object({
        baseUrl: z.string().url(),
        apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
        httpHeaders: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    environment: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const AgentSpecSchema = z.discriminatedUnion('kind', [
  ElloAgentSpecSchema,
  ClaudeCodeAgentSpecSchema,
  CodexAgentSpecSchema,
]);

// The Command Run refactor did not change the serialized Agent definition.
// Keep a named artifact contract so readers can evolve independently later.
export const AgentArtifactSpecSchema = AgentSpecSchema;

const AgentRuntimeBase = {
  schema: z.literal('ello.benchmark.agent-runtime.v1'),
  agentId: AgentIdSchema,
  displayName: z.string().min(1),
  agentConfigHash: z.string().regex(/^[0-9a-f]{64}$/u),
  adapterContractVersion: z.enum(['1', '2']),
  expectedModel: z.string().min(1),
  observedModel: z.string().min(1),
  configSha256: z.string().regex(/^[0-9a-f]{64}$/u),
} as const;

export const ElloAgentRuntimeSchema = z
  .object({
    ...AgentRuntimeBase,
    adapterContractVersion: z.literal('2'),
    kind: z.literal('ello'),
    primaryModel: z.string().min(1),
    auxiliaryModel: z.string().min(1),
    promptMode: ElloPromptModeSchema,
    enabledTools: z.tuple([z.literal('command_run')]),
    toolsetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

/** Read-only v1 contract from after Command Run tool provenance was introduced. */
export const LegacyElloCommandRunRuntimeSchema = z
  .object({
    ...AgentRuntimeBase,
    adapterContractVersion: z.literal('1'),
    kind: z.literal('ello'),
    primaryModel: z.string().min(1),
    auxiliaryModel: z.string().min(1),
    enabledTools: z.tuple([z.literal('command_run')]),
    toolsetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

/** Read-only v1 contract for Ello artifacts created before tool provenance. */
export const LegacyElloAgentRuntimeSchema =
  LegacyElloCommandRunRuntimeSchema.omit({
    enabledTools: true,
    toolsetFingerprint: true,
  });

const ExternalAgentRuntimeBase = {
  ...AgentRuntimeBase,
  executablePath: z.string().min(1),
  expectedVersion: z.string().min(1),
  observedVersion: z.string().min(1),
  executableSha256: z.string().regex(/^[0-9a-f]{64}$/u),
} as const;

export const ClaudeCodeAgentRuntimeSchema = z
  .object({
    ...ExternalAgentRuntimeBase,
    kind: z.literal('claude-code'),
    reasoningEffort: ModelReasoningEffortSchema.optional(),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
  })
  .strict();

export const CodexAgentRuntimeSchema = z
  .object({
    ...ExternalAgentRuntimeBase,
    adapterContractVersion: z.literal('1'),
    kind: z.literal('codex'),
    reasoningEffort: ReasoningEffortSchema,
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
  })
  .strict();

export const AgentRuntimeProvenanceSchema = z.discriminatedUnion('kind', [
  ElloAgentRuntimeSchema,
  ClaudeCodeAgentRuntimeSchema,
  CodexAgentRuntimeSchema,
]);

export const AgentArtifactRuntimeProvenanceSchema = z.union([
  AgentRuntimeProvenanceSchema,
  LegacyElloCommandRunRuntimeSchema,
  LegacyElloAgentRuntimeSchema,
]);

export type AgentSpec = z.infer<typeof AgentSpecSchema>;
export type AgentArtifactSpec = z.infer<typeof AgentArtifactSpecSchema>;
export type ElloAgentSpec = z.infer<typeof ElloAgentSpecSchema>;
export type BenchmarkModel = z.infer<typeof BenchmarkModelSchema>;
export type ClaudeCodeAgentSpec = z.infer<typeof ClaudeCodeAgentSpecSchema>;
export type CodexAgentSpec = z.infer<typeof CodexAgentSpecSchema>;
export type AgentRuntimeProvenance = z.infer<
  typeof AgentRuntimeProvenanceSchema
>;
export type AgentArtifactRuntimeProvenance = z.infer<
  typeof AgentArtifactRuntimeProvenanceSchema
>;
