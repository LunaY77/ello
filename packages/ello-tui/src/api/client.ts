import {
  CLIENT_NOTIFICATION_SCHEMAS,
  CLIENT_REQUEST_SCHEMAS,
  ELLO_PROTOCOL_VERSION,
  RpcMessageSchema,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_SCHEMAS,
  parseClientResult,
  parseServerNotificationParams,
  parseServerRequestParams,
  parseServerRequestResult,
  type ClientMethod,
  type ClientNotificationMethod,
  type ClientNotificationParams,
  type ClientParams,
  type ClientResult,
  type InitializeParamsSchema,
  type InitializeResultSchema,
  type RpcRequestId,
  type RpcResponse,
  type ServerNotification,
  type ServerNotificationMethod,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
} from '@ello/agent/protocol';
import type { z } from 'zod';

import {
  ClientProtocolError,
  RequestTimeoutError,
  ResponseValidationError,
  ServerResponseError,
  TransportClosedError,
} from './request-errors.js';
import type { ClientTransport } from './transport.js';

type InitializeParams = z.input<typeof InitializeParamsSchema>;
type InitializeResult = z.output<typeof InitializeResultSchema>;

export interface AppServerClientOptions {
  readonly transport: ClientTransport;
  readonly requestTimeoutMs?: number;
}

export interface IncomingServerRequest<M extends ServerRequestMethod> {
  readonly id: string;
  readonly method: M;
  readonly params: ServerRequestParams<M>;
  respond(result: ServerRequestResult<M>): Promise<void>;
  reject(error: {
    readonly code: number;
    readonly message: string;
    readonly data?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

type NotificationListener = (notification: ServerNotification) => void;
type ServerRequestListener = (
  request: IncomingServerRequest<ServerRequestMethod>,
) => void | Promise<void>;

interface PendingRequest {
  readonly method: ClientMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export type AppServerClientState =
  | 'disconnected'
  | 'connected'
  | 'initializing'
  | 'ready'
  | 'closed';

/**
 * 唯一的 RPC 关联层。UI 和 CLI 只调用 typed request，不接触 id map 或原始 JSON。
 */
export class AppServerClient {
  private readonly transport: ClientTransport;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<RpcRequestId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private nextRequestId = 1;
  private readTask: Promise<void> | undefined;
  private closeError: Error | undefined;
  private currentState: AppServerClientState = 'disconnected';

  constructor(options: AppServerClientOptions) {
    this.transport = options.transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get state(): AppServerClientState {
    return this.currentState;
  }

  async connect(): Promise<void> {
    if (this.currentState !== 'disconnected') {
      throw new ClientProtocolError(
        `Cannot connect App Server client from ${this.currentState}.`,
      );
    }
    this.currentState = 'connected';
    this.readTask = this.readLoop();
    void this.readTask.catch((error: unknown) => this.fail(error));
  }

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.currentState !== 'connected') {
      throw new ClientProtocolError(
        `Cannot initialize App Server client from ${this.currentState}.`,
      );
    }
    if (params.protocolVersion !== ELLO_PROTOCOL_VERSION) {
      throw new ClientProtocolError(
        'Client protocol version is not supported.',
      );
    }
    this.currentState = 'initializing';
    try {
      const result = await this.requestInternal('initialize', params);
      await this.notifyInternal('initialized', {});
      this.currentState = 'ready';
      return result;
    } catch (error) {
      this.currentState = 'connected';
      throw error;
    }
  }

  request<M extends Exclude<ClientMethod, 'initialize'>>(
    method: M,
    params: ClientParams<M>,
  ): Promise<ClientResult<M>> {
    if (this.currentState !== 'ready') {
      return Promise.reject(
        new ClientProtocolError(
          `Cannot send ${method} while client is ${this.currentState}.`,
        ),
      );
    }
    return this.requestInternal(method, params);
  }

  notify<M extends ClientNotificationMethod>(
    method: M,
    params: ClientNotificationParams<M>,
  ): Promise<void> {
    if (this.currentState !== 'ready') {
      return Promise.reject(
        new ClientProtocolError(
          `Cannot send ${method} while client is ${this.currentState}.`,
        ),
      );
    }
    return this.notifyInternal(method, params);
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.currentState === 'closed') return;
    this.currentState = 'closed';
    this.rejectPending(new TransportClosedError());
    await this.transport.close('client closed');
    await this.readTask;
  }

  private requestInternal<M extends ClientMethod>(
    method: M,
    params: ClientParams<M>,
  ): Promise<ClientResult<M>> {
    if (this.closeError !== undefined) return Promise.reject(this.closeError);
    const parsedParams = CLIENT_REQUEST_SCHEMAS[method].parse(params);
    const id = this.nextRequestId++;
    return new Promise<ClientResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new RequestTimeoutError(id, method, this.requestTimeoutMs));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as ClientResult<M>),
        reject,
        timer,
      });
      void this.send({
        jsonrpc: '2.0',
        id,
        method,
        params: parsedParams,
      }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  private async notifyInternal<M extends ClientNotificationMethod>(
    method: M,
    params: ClientNotificationParams<M>,
  ): Promise<void> {
    const parsedParams = CLIENT_NOTIFICATION_SCHEMAS[method].parse(params);
    await this.send({ jsonrpc: '2.0', method, params: parsedParams });
  }

  private async send(
    message: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.currentState === 'closed' || this.closeError !== undefined) {
      throw this.closeError ?? new TransportClosedError();
    }
    await this.transport.send(this.encoder.encode(JSON.stringify(message)));
  }

  private async readLoop(): Promise<void> {
    for await (const bytes of this.transport.messages()) {
      const text = this.decoder.decode(bytes);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new ClientProtocolError('Server sent malformed JSON.', {
          cause: error,
        });
      }
      const message = RpcMessageSchema.safeParse(value);
      if (!message.success) {
        throw new ClientProtocolError(
          'Server sent an invalid JSON-RPC message.',
          {
            cause: message.error,
          },
        );
      }
      await this.dispatch(message.data);
    }
    if (this.currentState !== 'closed') {
      throw new TransportClosedError(
        'App Server transport ended unexpectedly.',
      );
    }
  }

  private async dispatch(
    message: z.output<typeof RpcMessageSchema>,
  ): Promise<void> {
    if ('id' in message && !('method' in message)) {
      this.handleResponse(message);
      return;
    }
    if ('id' in message) {
      await this.handleServerRequest(message);
      return;
    }
    this.handleNotification(message);
  }

  private handleResponse(message: RpcResponse): void {
    if (message.id === null) {
      throw new ClientProtocolError('Server returned a null response id.');
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      throw new ClientProtocolError(
        `Server returned unknown response id ${String(message.id)}.`,
      );
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) {
      pending.reject(new ServerResponseError(message.error));
      return;
    }
    try {
      pending.resolve(parseClientResult(pending.method, message.result));
    } catch (error) {
      pending.reject(
        new ResponseValidationError(
          message.id,
          pending.method,
          message.result,
          { cause: error },
        ),
      );
    }
  }

  private async handleServerRequest(message: {
    readonly id: RpcRequestId;
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    if (typeof message.id !== 'string') {
      throw new ClientProtocolError('Server Request id must be a string.');
    }
    if (!(message.method in SERVER_REQUEST_SCHEMAS)) {
      await this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Unknown Server Request ${message.method}.`,
        },
      });
      return;
    }
    const method = message.method as ServerRequestMethod;
    const params = parseServerRequestParams(method, message.params);
    let settled = false;
    const incoming = {
      id: message.id,
      method,
      params,
      respond: async (result: ServerRequestResult<typeof method>) => {
        if (settled) {
          throw new ClientProtocolError(
            `Server Request ${message.id} is already resolved.`,
          );
        }
        settled = true;
        const parsed = parseServerRequestResult(method, result);
        await this.send({ jsonrpc: '2.0', id: message.id, result: parsed });
      },
      reject: async (error: {
        readonly code: number;
        readonly message: string;
        readonly data?: Readonly<Record<string, unknown>>;
      }) => {
        if (settled) {
          throw new ClientProtocolError(
            `Server Request ${message.id} is already resolved.`,
          );
        }
        settled = true;
        await this.send({ jsonrpc: '2.0', id: message.id, error });
      },
    } as IncomingServerRequest<ServerRequestMethod>;
    for (const listener of this.serverRequestListeners) {
      await listener(incoming);
      if (settled) return;
    }
    if (!settled) {
      await incoming.reject({
        code: -32601,
        message: `No Client handler accepted ${method}.`,
      });
    }
  }

  private handleNotification(message: {
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  }): void {
    if (!(message.method in SERVER_NOTIFICATION_SCHEMAS)) {
      throw new ClientProtocolError(
        `Server sent unknown notification ${message.method}.`,
      );
    }
    const method = message.method as ServerNotificationMethod;
    const notification = {
      method,
      params: parseServerNotificationParams(method, message.params),
    } as ServerNotification;
    for (const listener of this.notificationListeners) listener(notification);
  }

  private fail(reason: unknown): void {
    const error =
      reason instanceof Error
        ? reason
        : new TransportClosedError(String(reason));
    this.closeError = error;
    this.currentState = 'closed';
    this.rejectPending(error);
    void this.transport.close(error.message).catch(() => undefined);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
