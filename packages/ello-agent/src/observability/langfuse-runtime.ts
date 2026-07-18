import { LangfuseSpanProcessor } from '@langfuse/otel';
import { context, trace, type Span, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import type { LangfuseTracingConfig } from '../config/index.js';

export interface ChildRunRelation {
  readonly childRunId: string;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly agentName: string;
  readonly background: boolean;
}

export interface LangfuseTracingRuntime {
  readonly tracer: Tracer;
  readonly sessionId: string;
  readonly config: LangfuseTracingConfig;
  registerChildRun(relation: ChildRunRelation): void;
  consumeChildRun(runId: string): ChildRunRelation | undefined;
  forceFlush(runId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export function createLangfuseTracingRuntime(input: {
  readonly sessionId: string;
  readonly config: LangfuseTracingConfig;
}): LangfuseTracingRuntime {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (publicKey === undefined || publicKey === '') {
    throw new Error(
      'LANGFUSE_PUBLIC_KEY is required when observability.langfuse is configured.',
    );
  }
  if (secretKey === undefined || secretKey === '') {
    throw new Error(
      'LANGFUSE_SECRET_KEY is required when observability.langfuse is configured.',
    );
  }
  const baseUrl = new URL(input.config.base_url);
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error(
      `Langfuse base_url must use HTTP(S): ${input.config.base_url}`,
    );
  }
  const endpointBaseUrl = baseUrl.toString().replace(/\/$/, '');
  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl: endpointBaseUrl,
    environment: input.config.environment,
    release: input.config.release,
    shouldExportSpan: () => true,
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer('ello.coding-agent');
  const relations = new Map<string, ChildRunRelation>();
  let shutdownTask: Promise<void> | undefined;
  return {
    tracer,
    sessionId: input.sessionId,
    config: input.config,
    registerChildRun(relation): void {
      if (relations.has(relation.childRunId)) {
        throw new Error(
          `Child run relation already registered: ${relation.childRunId}`,
        );
      }
      relations.set(relation.childRunId, relation);
    },
    consumeChildRun(runId): ChildRunRelation | undefined {
      const relation = relations.get(runId);
      if (relation !== undefined) {
        relations.delete(runId);
      }
      return relation;
    },
    forceFlush: async (): Promise<void> => {
      await provider.forceFlush();
    },
    shutdown(): Promise<void> {
      shutdownTask ??= provider.shutdown();
      return shutdownTask;
    },
  };
}

export function startChildSpan(
  tracer: Tracer,
  name: string,
  parent: Span,
  startedAt: string,
): Span {
  return tracer.startSpan(
    name,
    { startTime: new Date(startedAt) },
    trace.setSpan(context.active(), parent),
  );
}
