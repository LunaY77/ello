import type { AgentError } from './types.js';

/** 将任意异常标准化为可序列化 AgentError。 */
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
