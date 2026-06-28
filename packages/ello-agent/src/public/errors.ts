/**
 * 错误归一化工具。
 *
 * 把运行各处抛出的任意异常统一收敛为可序列化的 {@link AgentError} 形态，
 * 以便安全地放进事件流、运行结果与 JSONL 会话（避免直接抛出无法序列化的
 * `Error` 实例破坏持久化与跨边界传输）。
 */
import type { AgentError } from './types.js';

/** 将任意异常标准化为可序列化的 {@link AgentError}。 */
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
