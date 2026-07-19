import type {
  AppServerErrorType,
  RpcError,
  RpcRequestId,
} from '@ello/agent/protocol';

export class TransportClosedError extends Error {
  constructor(message = 'App Server transport is closed.') {
    super(message);
    this.name = 'TransportClosedError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    readonly requestId: RpcRequestId,
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`App Server request ${method} timed out after ${timeoutMs} ms.`);
    this.name = 'RequestTimeoutError';
  }
}

export class ResponseValidationError extends Error {
  constructor(
    readonly requestId: RpcRequestId,
    readonly method: string,
    readonly response: unknown,
    options?: ErrorOptions,
  ) {
    super(`App Server returned an invalid ${method} response.`, options);
    this.name = 'ResponseValidationError';
  }
}

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

export class ClientProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClientProtocolError';
  }
}
