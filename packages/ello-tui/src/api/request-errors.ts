/**
 * 本文件定义 TUI JSON-RPC 边界可供 CLI 与 UI 稳定识别的错误类型。
 *
 * 框架错误、Ello error data、结果 schema 失败和 transport 生命周期失败必须保持可区分，调用方不能依赖
 * message 文本猜测错误类别。
 */
import type { AppServerErrorType, RpcError } from '@ello/agent/protocol';

/** transport 已关闭或意外结束。 */
export class TransportClosedError extends Error {
  constructor(message = 'App Server transport is closed.') {
    super(message);
    this.name = 'TransportClosedError';
  }
}

/** 单个 Client Request 超过声明的 deadline，连接会随之关闭。 */
export class RequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`App Server request ${method} timed out after ${timeoutMs} ms.`);
    this.name = 'RequestTimeoutError';
  }
}

/** Server success response 未通过对应 method 的 result schema。 */
export class ResponseValidationError extends Error {
  constructor(
    readonly method: string,
    readonly response: unknown,
    options?: ErrorOptions,
  ) {
    super(`App Server returned an invalid ${method} response.`, options);
    this.name = 'ResponseValidationError';
  }
}

/** 经过 `RpcErrorSchema` 校验的 Server JSON-RPC error。 */
export class ServerResponseError extends Error {
  readonly code: number;
  readonly type: AppServerErrorType | undefined;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(readonly rpcError: RpcError) {
    super(rpcError.message);
    this.name = 'ServerResponseError';
    this.code = rpcError.code;
    this.type = rpcError.data?.type;
    this.retryable = rpcError.data?.retryable ?? false;
    this.details = rpcError.data?.details;
  }
}

/** Client 本地握手、消息 envelope 或状态机违反协议约束。 */
export class ClientProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClientProtocolError';
  }
}
