import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'smol-toml';
import { z } from 'zod';

import {
  AgentSpecSchema,
  BenchmarkSuiteIdSchema,
  ModelReasoningEffortSchema,
  ReasoningEffortSchema,
  validateBenchmarkConfig,
  validateBenchmarkDefinition,
  type AgentSpec,
  type BenchmarkConfig,
  type BenchmarkDefinition,
} from '../../domain/contract/index.js';
import { sha256, stableJson } from '../../domain/hash.js';
import { getBenchmarkSuite } from '../corpus/suite.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

export const DEFAULT_CONFIG_PATH = path.join(
  packageRoot,
  'config',
  'benchmark.toml',
);

const HeaderSchema = z.record(z.string().min(1), z.string().min(1));
const ModelCommon = {
  api_model: z.string().min(1),
  base_url: z.string().url(),
  api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
  http_headers: HeaderSchema.optional(),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  reasoning_effort: ModelReasoningEffortSchema,
} as const;
const RawModelSchema = z.discriminatedUnion('protocol', [
  z
    .object({
      protocol: z.literal('openai'),
      endpoint: z.enum(['responses', 'chat']),
      ...ModelCommon,
    })
    .strict(),
  z
    .object({
      protocol: z.literal('openai-compatible'),
      endpoint: z.enum(['responses', 'chat']),
      ...ModelCommon,
    })
    .strict(),
  z
    .object({
      protocol: z.literal('anthropic'),
      auth_scheme: z.enum(['api-key', 'bearer']),
      ...ModelCommon,
    })
    .strict(),
]);
const RawBinarySchema = z
  .object({
    path_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    expected_version: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
const RawConnectionSchema = z
  .object({
    base_url: z.string().url(),
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    http_headers: HeaderSchema.optional(),
  })
  .strict();
const RawFeaturesSchema = z.object({ subagents: z.boolean() }).strict();
const RawAgentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().min(1),
      display_name: z.string().min(1),
      kind: z.literal('ello'),
      primary_model: z.string().min(1),
      auxiliary_model: z.string().min(1),
      models: z.record(z.string().min(1), RawModelSchema),
      features: RawFeaturesSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      display_name: z.string().min(1),
      kind: z.literal('claude-code'),
      model: z.string().min(1),
      reasoning_effort: ModelReasoningEffortSchema,
      binary: RawBinarySchema,
      connection: RawConnectionSchema,
      environment: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      display_name: z.string().min(1),
      kind: z.literal('codex'),
      model: z.string().min(1),
      reasoning_effort: ReasoningEffortSchema,
      binary: RawBinarySchema,
      connection: RawConnectionSchema,
      environment: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);
const AgentsDocumentSchema = z
  .object({
    schema: z.literal('ello.benchmark.agents.v2'),
    agent: z.array(RawAgentSchema).min(1),
  })
  .strict();
const BenchmarkDocumentSchema = z
  .object({
    schema: z.literal('ello.benchmark.config.v2'),
    suite: BenchmarkSuiteIdSchema,
    agents_file: z.string().min(1),
    execution: z
      .object({
        replicates: z.number().int().positive(),
        concurrency: z.number().int().positive(),
        max_infrastructure_retries: z.number().int().min(0).max(5),
      })
      .strict(),
    report: z
      .object({
        render_charts: z.boolean(),
        publishability: z
          .object({
            require_complete_matrix: z.boolean(),
            require_complete_usage: z.boolean(),
            require_tool_audit: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    container: z
      .object({
        pull_policy: z.enum(['if-absent', 'always', 'never']),
        network: z.literal('bridge'),
        cleanup: z.enum(['always', 'on-success', 'never']),
      })
      .strict(),
  })
  .strict();

export async function loadBenchmarkConfig(
  configPath = DEFAULT_CONFIG_PATH,
): Promise<BenchmarkConfig> {
  const resolvedPath = path.resolve(configPath);
  const benchmark = BenchmarkDocumentSchema.parse(
    parse(await readFile(resolvedPath, 'utf8')),
  );
  const agentsPath = path.resolve(
    path.dirname(resolvedPath),
    benchmark.agents_file,
  );
  const agentsDocument = AgentsDocumentSchema.parse(
    parse(await readFile(agentsPath, 'utf8')),
  );
  return resolveBenchmarkDefinition(
    validateBenchmarkDefinition({
      schema: benchmark.schema,
      suite: benchmark.suite,
      execution: {
        replicates: benchmark.execution.replicates,
        concurrency: benchmark.execution.concurrency,
        maxInfrastructureRetries:
          benchmark.execution.max_infrastructure_retries,
      },
      report: {
        schema: 'ello.benchmark.report-config.v2',
        renderCharts: benchmark.report.render_charts,
        publishability: {
          requireCompleteMatrix:
            benchmark.report.publishability.require_complete_matrix,
          requireCompleteUsage:
            benchmark.report.publishability.require_complete_usage,
          requireToolAudit: benchmark.report.publishability.require_tool_audit,
        },
      },
      container: {
        pullPolicy: benchmark.container.pull_policy,
        network: benchmark.container.network,
        cleanup: benchmark.container.cleanup,
      },
      agents: agentsDocument.agent.map(mapAgent),
    }),
  );
}

export function resolveBenchmarkDefinition(
  definition: BenchmarkDefinition,
): BenchmarkConfig {
  const suite = getBenchmarkSuite(definition.suite);
  const actualTaskSetHash = sha256(stableJson(suite.tasks));
  if (actualTaskSetHash !== suite.metadata.taskSetHash) {
    throw new Error(
      `Suite task-set hash mismatch: expected ${suite.metadata.taskSetHash}, received ${actualTaskSetHash}.`,
    );
  }
  return deepFreeze(
    validateBenchmarkConfig({
      schema: 'ello.benchmark.resolved-config.v2',
      suite: suite.metadata,
      execution: definition.execution,
      report: definition.report,
      container: definition.container,
      agents: definition.agents,
      tasks: suite.tasks,
    }),
  );
}

export function semanticConfigHash(config: BenchmarkConfig): string {
  return sha256(stableJson(config));
}

function mapAgent(raw: z.infer<typeof RawAgentSchema>): AgentSpec {
  if (raw.kind === 'ello') {
    return AgentSpecSchema.parse({
      id: raw.id,
      displayName: raw.display_name,
      kind: raw.kind,
      primaryModel: raw.primary_model,
      auxiliaryModel: raw.auxiliary_model,
      features: raw.features,
      models: Object.fromEntries(
        Object.entries(raw.models).map(([name, model]) => [
          name,
          {
            protocol: model.protocol,
            ...(model.protocol === 'anthropic'
              ? { authScheme: model.auth_scheme }
              : { endpoint: model.endpoint }),
            apiModel: model.api_model,
            baseUrl: model.base_url,
            apiKeyEnv: model.api_key_env,
            ...(model.http_headers === undefined
              ? {}
              : { httpHeaders: model.http_headers }),
            contextWindow: model.context_window,
            maxOutputTokens: model.max_output_tokens,
            reasoningEffort: model.reasoning_effort,
          },
        ]),
      ),
    });
  }
  return AgentSpecSchema.parse({
    id: raw.id,
    displayName: raw.display_name,
    kind: raw.kind,
    model: raw.model,
    reasoningEffort: raw.reasoning_effort,
    binary: {
      pathEnv: raw.binary.path_env,
      expectedVersion: raw.binary.expected_version,
      sha256: raw.binary.sha256,
    },
    connection: {
      baseUrl: raw.connection.base_url,
      apiKeyEnv: raw.connection.api_key_env,
      ...(raw.connection.http_headers === undefined
        ? {}
        : { httpHeaders: raw.connection.http_headers }),
    },
    ...(raw.environment === undefined ? {} : { environment: raw.environment }),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
