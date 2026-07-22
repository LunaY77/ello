/**
 * 本文件负责基础设施层的“langfuse-runtime”模块职责。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { context, trace, type Span, type Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import type { LangfuseTracingConfig } from '../../features/config/index.js';

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

/**
 * 构造 基础设施层的 `langfuse-runtime` 模块 中的 `createLangfuseTracingRuntime` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `input`: `createLangfuseTracingRuntime` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `createLangfuseTracingRuntime` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 基础设施层的 `langfuse-runtime` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
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

/**
 * 在 基础设施层的 `langfuse-runtime` 模块 中执行 `startChildSpan` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `tracer`: `startChildSpan` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `name`: `startChildSpan` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `parent`: `startChildSpan` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `startedAt`: `startChildSpan` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `startChildSpan` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 基础设施层的 `langfuse-runtime` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
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
