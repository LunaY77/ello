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

  constructor(options: AppServerErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppServerError';
    this.type = options.type;
    this.code = APP_SERVER_ERROR_CODES[options.type];
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
