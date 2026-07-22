/**
 * 错误归一化工具。
 *
 * 把运行各处抛出的任意异常统一收敛为可序列化的 {@link AgentError} 形态，
 * 以便安全地放进事件流、运行结果与 JSONL 会话（避免直接抛出无法序列化的
 * `Error` 实例破坏持久化与跨边界传输）。
 */
import type { AgentError } from './contracts.js';

export class ModelAdapterProtocolError extends Error {
  override readonly name = 'ModelAdapterProtocolError';
}

export class AgentStreamBackpressureError extends Error {
  override readonly name = 'AgentStreamBackpressureError';

  /**
   * 创建 `AgentStreamBackpressureError`，由该实例独占 产品 Agent Agent engine `errors` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `capacity`: 当前操作使用的数量上限；超出限制时直接失败或按契约截断。
   */
  constructor(readonly capacity: number) {
    super(`Agent stream buffer exceeded its capacity of ${capacity} events.`);
  }
}

/**
 * 将任意异常标准化为可序列化的 {@link AgentError}。
 *
 * Args:
 * - `error`: 上游捕获的失败值；函数保留原始 cause 并转换为当前错误契约。
 *
 * Returns:
 * - 返回 `normalizeAgentError` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function normalizeAgentError(error: unknown): AgentError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      ...(error.cause !== undefined ? { cause: error.cause } : {}),
    };
  }
  return {
    name: 'Error',
    message: String(error),
  };
}
