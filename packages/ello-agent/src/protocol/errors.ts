/**
 * 本文件负责 Protocol 的错误分类与失败语义。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 */
import { z } from 'zod';

export const AppServerErrorTypeSchema = z.enum([
  'parseError',
  'invalidRequest',
  'methodNotFound',
  'invalidParams',
  'configInvalid',
  'responseValidationFailed',
  'internal',
  'serverOverloaded',
  'notInitialized',
  'alreadyInitialized',
  'threadNotFound',
  'threadBusy',
  'turnMismatch',
  'requestResolved',
  'permissionDenied',
  'pathOutsideWorkspace',
  'storageCorrupt',
  'protocolMismatch',
]);

export type AppServerErrorType = z.infer<typeof AppServerErrorTypeSchema>;

export const APP_SERVER_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  serverOverloaded: -32001,
  notInitialized: -32002,
  alreadyInitialized: -32003,
  threadNotFound: -32004,
  threadBusy: -32005,
  turnMismatch: -32006,
  requestResolved: -32007,
  permissionDenied: -32008,
  pathOutsideWorkspace: -32009,
  storageCorrupt: -32010,
  protocolMismatch: -32011,
  configInvalid: -32012,
  responseValidationFailed: -32013,
} as const satisfies Record<AppServerErrorType, number>;

export interface AppServerErrorOptions {
  readonly type: AppServerErrorType;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Server 内部只按稳定的 `type` 分支，英文 message 仅用于给人诊断。
 */
export class AppServerError extends Error {
  readonly type: AppServerErrorType;
  readonly code: number;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  /**
   * 创建 `AppServerError`，由该实例独占 JSON-RPC 协议的 `errors` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `options`: 仅作用于 `constructor AppServerError` 的调用选项；函数只读取该对象，不保留可变引用。
   */
  constructor(options: AppServerErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppServerError';
    this.type = options.type;
    this.code = APP_SERVER_ERROR_CODES[options.type];
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * 执行 JSON-RPC 协议的 `errors` 模块 定义的 `invalidParams` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - 返回 `invalidParams` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function invalidParams(message: string): AppServerError {
  return new AppServerError({ type: 'invalidParams', message });
}
