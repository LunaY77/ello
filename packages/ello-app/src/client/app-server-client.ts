/**
 * ello-app 的 typed JSON-RPC Client。WebView 环境不能使用 vscode-jsonrpc/node,
 * 这里只保留协议必需语义:请求/响应按 ID 关联、notification 分发、
 * Server Request 持久 ID 应答、所有出入站值复用 @ello/agent/protocol schema 校验。
 * 校验失败、未知 method、传输中断都视为致命协议错误,直接进入 closed 状态。
 */
import {
  parseClientParams,
  parseClientResult,
  parseClientNotificationParams,
  parseServerNotificationParams,
  parseServerRequestParams,
  parseServerRequestResult,
  RpcMessageSchema,
  type ClientMethod,
  type ClientNotificationMethod,
  type ClientNotificationParams,
  type ClientResult,
  type InitializeResultSchema,
  type ParsedClientParams,
  type RpcError,
  type RpcMessage,
  type RpcRequestId,
  type ServerNotification,
  type ServerNotificationMethod,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
  CLIENT_NOTIFICATION_SCHEMAS,
  CLIENT_REQUEST_SCHEMAS,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_SCHEMAS,
} from '@ello/agent/protocol';
import type { z } from 'zod';

import type { AppTransport } from './transport.js';
import { TransportClosedError } from './transport.js';

export class ClientProtocolError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ClientProtocolError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`App Server request ${method} timed out after ${timeoutMs}ms.`);
    this.name = 'RequestTimeoutError';
  }
}

export class ResponseValidationError extends Error {
  constructor(
    readonly method: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`App Server response for ${method} failed schema validation.`, options);
    this.name = 'ResponseValidationError';
  }
}

export class ServerResponseError extends Error {
  readonly rpcError: RpcError;

  constructor(error: RpcError) {
    super(`App Server rejected the request: ${error.message} (${error.code})`);
    this.name = 'ServerResponseError';
    this.rpcError = error;
  }

  get type(): string | undefined {
    return this.rpcError.data?.type;
  }
}

export interface IncomingServerRequest<M extends ServerRequestMethod> {
  readonly id: string;
  readonly method: M;
  readonly params: ServerRequestParams<M>;
  respond(result: ServerRequestResult<M>): Promise<void>;
  reject(error: { readonly code: number; readonly message: string }): Promise<void>;
}

export type AppServerClientState =
  | 'disconnected'
  | 'connected'
  | 'initializing'
  | 'ready'
  | 'closed';

type NotificationListener = (notification: ServerNotification) => void;
type ServerRequestListener = (
  request: IncomingServerRequest<ServerRequestMethod>,
) => boolean | void | Promise<boolean | void>;
type CloseListener = (error: Error | undefined) => void;

interface PendingRequest {
  readonly method: ClientMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** UI 唯一的 typed RPC facade;调用方不接触 wire ID 或 frame。 */
export class AppServerClient {
  private readonly transport: AppTransport;
  private readonly requestTimeoutMs: number;
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly pending = new Map<RpcRequestId, PendingRequest>();
  private nextId = 1;
  private currentState: AppServerClientState = 'disconnected';
  private closeError: Error | undefined;
  private transportClosePromise: Promise<void> | undefined;

  constructor(options: {
    readonly transport: AppTransport;
    readonly requestTimeoutMs?: number;
  }) {
    this.transport = options.transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    ) {
      throw new Error('App Server request timeout must be a positive integer.');
    }
  }

  get state(): AppServerClientState {
    return this.currentState;
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** 启动唯一读取循环;连接结束时清空 pending 并通知 close listeners。 */
  async connect(): Promise<void> {
    if (this.currentState !== 'disconnected') {
      throw new ClientProtocolError(
        `Cannot connect App Server client from ${this.currentState}.`,
      );
    }
    this.currentState = 'connected';
    void this.readLoop();
  }

  /** initialize -> initialized 握手;只有 ready 后才能发业务请求。 */
  async initialize(
    params: ParsedClientParams<'initialize'>,
  ): Promise<z.output<typeof InitializeResultSchema>> {
    if (this.currentState !== 'connected') {
      throw new ClientProtocolError(
        `Cannot initialize App Server client from ${this.currentState}.`,
      );
    }
    this.currentState = 'initializing';
    try {
      const result = await this.request('initialize', params);
      await this.notify('initialized', {});
      this.currentState = 'ready';
      return result;
    } catch (error) {
      if (this.closeError === undefined) this.currentState = 'connected';
      throw error;
    }
  }

  /** 发送业务 Client Request;params 与 result 都过协议 schema。 */
  async request<M extends ClientMethod>(
    method: M,
    params: ClientParamsWire<M>,
  ): Promise<ClientResult<M>> {
    if (this.currentState !== 'ready' && method !== 'initialize') {
      throw new ClientProtocolError(
        `Cannot send ${method} while client is ${this.currentState}.`,
      );
    }
    if (this.pending.size >= 512) {
      throw new ClientProtocolError('Too many in-flight App Server requests.');
    }
    const id = this.nextId;
    this.nextId += 1;
    const parsedParams = parseClientParams(method, params);
    return new Promise<ClientResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new RequestTimeoutError(method, this.requestTimeoutMs);
        this.fail(error);
        reject(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.sendFrame({
        jsonrpc: '2.0',
        id,
        method,
        params: parsedParams as Record<string, unknown>,
      }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** 发送 Client Notification。 */
  async notify<M extends ClientNotificationMethod>(
    method: M,
    params: ClientNotificationParams<M>,
  ): Promise<void> {
    const parsed = parseClientNotificationParams(method, params);
    await this.sendFrame({
      jsonrpc: '2.0',
      method,
      params: parsed as Record<string, unknown>,
    });
  }

  /**
   * 应答 Server Request。live 到达与快照重建的审批共用此路径 ——
   * wire ID 是持久化 srvreq_* ID,审批 UI 必须使用原 ID 回复。
   */
  async respondToServerRequest<M extends ServerRequestMethod>(
    id: string,
    method: M,
    result: ServerRequestResult<M>,
  ): Promise<void> {
    const parsed = parseServerRequestResult(method, result);
    await this.sendFrame({ jsonrpc: '2.0', id, result: parsed });
  }

  /** 主动关闭;幂等。关闭后所有 pending 请求以 TransportClosedError 失败。 */
  async close(reason: string): Promise<void> {
    if (this.currentState === 'closed') {
      await this.transportClosePromise;
      return;
    }
    this.closeError = new TransportClosedError(reason);
    this.currentState = 'closed';
    this.settlePending(this.closeError);
    try {
      await this.closeTransport(reason);
    } catch (error) {
      this.closeError = error instanceof Error ? error : new Error(String(error));
      this.emitClose(this.closeError);
      throw this.closeError;
    }
    this.emitClose(undefined);
  }

  /** 致命错误路径:关闭连接并把所有 pending 置为失败。 */
  fail(error: Error): void {
    if (this.currentState === 'closed') return;
    this.closeError = error;
    this.currentState = 'closed';
    this.settlePending(error);
    this.emitClose(error);
    void this.closeTransport(error.message).catch((closeError: unknown) => {
      this.closeError =
        closeError instanceof Error ? closeError : new Error(String(closeError));
      this.emitClose(this.closeError);
    });
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const frame of this.transport.messages()) {
        if (this.currentState === 'closed') return;
        this.handleFrame(frame);
      }
      // 对端有序关闭。
      if (this.currentState !== 'closed') {
        this.fail(new TransportClosedError('App Server transport ended.'));
      }
    } catch (error) {
      if (this.currentState !== 'closed') {
        this.fail(
          error instanceof Error
            ? error
            : new TransportClosedError(String(error)),
        );
      }
    }
  }

  private handleFrame(frame: Uint8Array): void {
    if (frame.length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(frame));
    } catch (error) {
      this.fail(
        new ClientProtocolError('App Server sent an invalid JSON frame.', {
          cause: error,
        }),
      );
      return;
    }
    const parsed = RpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.fail(
        new ClientProtocolError('App Server frame failed JSON-RPC schema validation.', {
          cause: parsed.error,
        }),
      );
      return;
    }
    const message = parsed.data;
    if ('method' in message && 'id' in message) {
      this.handleServerRequest(message);
      return;
    }
    if ('method' in message) {
      this.handleNotification(message);
      return;
    }
    if ('id' in message) {
      this.handleResponse(message);
      return;
    }
    this.fail(new ClientProtocolError('Unrecognized App Server frame shape.'));
  }

  private handleResponse(message: Extract<RpcMessage, { readonly result: unknown }> | Extract<RpcMessage, { readonly error: RpcError }>): void {
    const id = message['id'];
    if (id === null || (typeof id !== 'string' && typeof id !== 'number')) {
      this.fail(new ClientProtocolError('App Server response has no valid id.'));
      return;
    }
    const entry = this.pending.get(id);
    if (entry === undefined) {
      // 超时或 server-request 应答的回执不属于 pending;未知响应 ID 是协议违约。
      this.fail(
        new ClientProtocolError(
          `App Server response references unknown request id ${String(id)}.`,
        ),
      );
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if ('error' in message) {
      const error = new ServerResponseError(message.error);
      entry.reject(error);
      return;
    }
    try {
      entry.resolve(parseClientResult(entry.method, message.result));
    } catch (error) {
      const validationError = new ResponseValidationError(entry.method, { cause: error });
      entry.reject(validationError);
      this.fail(validationError);
    }
  }

  private handleNotification(message: Extract<RpcMessage, { readonly method: string; readonly id?: never }>): void {
    const method = message.method;
    if (!(method in SERVER_NOTIFICATION_SCHEMAS)) {
      this.fail(
        new ClientProtocolError(
          `App Server sent unknown notification method ${String(method)}.`,
        ),
      );
      return;
    }
    let notification: ServerNotification;
    try {
      const params = parseServerNotificationParams(
        method as ServerNotificationMethod,
        message.params,
      );
      notification = {
        method: method as ServerNotificationMethod,
        params,
      } as ServerNotification;
    } catch (error) {
      this.fail(
        new ClientProtocolError(
          `App Server notification ${method} failed schema validation.`,
          { cause: error },
        ),
      );
      return;
    }
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }

  private handleServerRequest(message: Extract<RpcMessage, { readonly method: string; readonly id: string | number }>): void {
    const method = message.method;
    const id = message.id;
    if (typeof id !== 'string' || !id.startsWith('srvreq_')) {
      this.fail(
        new ClientProtocolError(
          'App Server request id is not a persistent srvreq_* id.',
        ),
      );
      return;
    }
    if (
      !(method in SERVER_REQUEST_SCHEMAS)
    ) {
      void this.sendFrame({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown server request ${String(method)}.` },
      }).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    let params: ServerRequestParams<ServerRequestMethod>;
    try {
      params = parseServerRequestParams(
        method as ServerRequestMethod,
        message.params,
      );
    } catch (error) {
      this.fail(
        new ClientProtocolError(
          `App Server request ${method} params failed schema validation.`,
          { cause: error },
        ),
      );
      return;
    }
    const typedMethod = method as ServerRequestMethod;
    const incoming: IncomingServerRequest<ServerRequestMethod> = {
      id,
      method: typedMethod,
      params,
      respond: (result) =>
        this.respondToServerRequest(id, typedMethod, result),
      reject: async (error) => {
        await this.sendFrame({ jsonrpc: '2.0', id, error });
      },
    };
    void this.dispatchServerRequest(incoming).catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async dispatchServerRequest(
    request: IncomingServerRequest<ServerRequestMethod>,
  ): Promise<void> {
    for (const listener of this.serverRequestListeners) {
      const handled = await listener(request);
      if (handled === true) return;
    }
    await request.reject({
      code: -32601,
      message: `No client handler for ${request.method}.`,
    });
  }

  private settlePending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private emitClose(error: Error | undefined): void {
    for (const listener of this.closeListeners) {
      listener(error);
    }
  }

  private async sendFrame(value: Record<string, unknown>): Promise<void> {
    try {
      await this.transport.send(encoder.encode(JSON.stringify(value)));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    }
  }

  private closeTransport(reason: string): Promise<void> {
    this.transportClosePromise ??= this.transport.close(reason);
    return this.transportClosePromise;
  }
}

/** ClientParams 以 z.input 表达(允许省略带默认值的字段)。 */
type ClientParamsWire<M extends ClientMethod> = z.input<
  (typeof CLIENT_REQUEST_SCHEMAS)[M]
>;

// 保持导入的 schema 表在类型层被引用,防止意外删减协议入口。
export type {
  ClientMethod,
  ClientNotificationMethod,
  ServerNotificationMethod,
  ServerRequestMethod,
};
export { CLIENT_REQUEST_SCHEMAS, CLIENT_NOTIFICATION_SCHEMAS };
