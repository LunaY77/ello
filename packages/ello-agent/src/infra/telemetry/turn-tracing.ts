/**
 * 本文件负责基础设施层的“turn-tracing”模块职责。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import type { AgentEventRecorder } from '../../features/agent/engine/index.js';
import type { LangfuseObservabilityConfig } from '../../features/config/index.js';

import { createLangfuseEventRecorder } from './langfuse-recorder.js';
import { createLangfuseTracingRuntime } from './langfuse-runtime.js';

export interface TurnTracing {
  readonly eventRecorder?: AgentEventRecorder;
  /**
   * 停止 基础设施层的 `turn-tracing` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 基础设施层的 `turn-tracing` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(): Promise<void>;
}

/**
 * 为生产 Turn 创建显式 tracing 生命周期。关闭配置完全离线；启用配置必须具备
 * 完整凭证，并由 Turn executor 在 Agent 关闭后释放 exporter。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 * - `threadId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
 *
 * Returns:
 * - 返回 `createTurnTracing` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 基础设施层的 `turn-tracing` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
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
