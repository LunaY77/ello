import type { AgentEventRecorder } from '../agent/engine/index.js';
import type { LangfuseObservabilityConfig } from '../config/index.js';

import { createLangfuseEventRecorder } from './langfuse-recorder.js';
import { createLangfuseTracingRuntime } from './langfuse-runtime.js';

export interface TurnTracing {
  readonly eventRecorder?: AgentEventRecorder;
  close(): Promise<void>;
}

/**
 * 为生产 Turn 创建显式 tracing 生命周期。关闭配置完全离线；启用配置必须具备
 * 完整凭证，并由 Turn executor 在 Agent 关闭后释放 exporter。
 */
export function createTurnTracing(
  config: LangfuseObservabilityConfig | undefined,
  threadId: string,
): TurnTracing {
  if (config?.enabled !== true) {
    return { close: () => Promise.resolve() };
  }
  const runtime = createLangfuseTracingRuntime({
    sessionId: threadId,
    config,
  });
  return {
    eventRecorder: createLangfuseEventRecorder({
      runtime,
      agentKind: 'primary',
    }),
    close: () => runtime.shutdown(),
  };
}
