import {
  AppServerError,
  parseServerRequestResult,
  type RpcResponse,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
} from '../../protocol/v1/index.js';

interface PendingRequest {
  readonly method: ServerRequestMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export type SendServerRequest = (
  message: Readonly<Record<string, unknown>>,
) => Promise<void>;

/** Server Request id 全局唯一；Client response 只在这里完成 callback。 */
export class PendingServerRequests {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly send: SendServerRequest) {}

  request<M extends ServerRequestMethod>(
    id: string,
    method: M,
    params: ServerRequestParams<M>,
  ): Promise<ServerRequestResult<M>> {
    if (this.pending.has(id)) {
      return Promise.reject(
        new AppServerError({
          type: 'invalidRequest',
          message: `Duplicate Server Request id ${id}.`,
        }),
      );
    }
    return new Promise<ServerRequestResult<M>>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as ServerRequestResult<M>),
        reject,
      });
      void this.send({ jsonrpc: '2.0', id, method, params }).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  resolve(response: RpcResponse): void {
    if (response.id === null || typeof response.id !== 'string') {
      throw new AppServerError({
        type: 'requestResolved',
        message: `Unknown Server Request response id ${String(response.id)}.`,
      });
    }
    const pending = this.pending.get(response.id);
    if (pending === undefined) {
      throw new AppServerError({
        type: 'requestResolved',
        message: `Server Request ${response.id} is already resolved or unknown.`,
      });
    }
    this.pending.delete(response.id);
    if ('error' in response) {
      pending.reject(
        new AppServerError({
          type: response.error.data?.type ?? 'internal',
          message: response.error.message,
          ...(response.error.data?.retryable === undefined
            ? {}
            : { retryable: response.error.data.retryable }),
          ...(response.error.data?.details === undefined
            ? {}
            : { details: response.error.data.details }),
        }),
      );
      return;
    }
    try {
      pending.resolve(parseServerRequestResult(pending.method, response.result));
    } catch (error) {
      pending.reject(
        new AppServerError({
          type: 'invalidRequest',
          message: `Invalid response for Server Request ${response.id}.`,
          cause: error,
        }),
      );
    }
  }

  disconnect(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
