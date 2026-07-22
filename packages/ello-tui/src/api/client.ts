/**
 * 本文件负责 TUI 的 typed JSON-RPC Client、握手状态和产品级 Server Request 交互。
 *
 * `vscode-jsonrpc` 独占 Client Request ID、pending response、乱序关联、Cancellation 和连接清理；
 * Ello 只保留 Zod 产品协议、initialize 状态、通知订阅以及需要用户延迟决策的 Server Request。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  CLIENT_NOTIFICATION_SCHEMAS,
  CLIENT_REQUEST_SCHEMAS,
  ELLO_PROTOCOL_VERSION,
  RpcErrorSchema,
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
  type ServerNotification,
  type ServerNotificationMethod,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
} from '@ello/agent/protocol';
import {
  CancellationTokenSource,
  ErrorCodes,
  Message,
  ResponseError,
  createMessageConnection,
  type CancellationToken,
  type MessageConnection,
  type MessageStrategy,
} from 'vscode-jsonrpc/node';
import type { z } from 'zod';

import {
  ClientProtocolError,
  RequestTimeoutError,
  ResponseValidationError,
  ServerResponseError,
  TransportClosedError,
} from './request-errors.js';
import {
  ClientMessageReader,
  ClientMessageWriter,
  type ClientTransport,
} from './transport.js';

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
) => boolean | void | Promise<boolean | void>;

export type AppServerClientState =
  | 'disconnected'
  | 'connected'
  | 'initializing'
  | 'ready'
  | 'closed';

/** UI 和 CLI 的唯一 typed RPC facade；调用方不接触 MessageConnection 或 wire ID。 */
export class AppServerClient {
  private readonly transport: ClientTransport;
  private readonly requestTimeoutMs: number;
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();
  private readonly serverRequestContext = new AsyncLocalStorage<
    string | number | null
  >();
  private readonly reader: ClientMessageReader;
  private readonly writer: ClientMessageWriter;
  private readonly rpc: MessageConnection;
  private closeTask: Promise<void> | undefined;
  private closeError: Error | undefined;
  private closeFailure: Error | undefined;
  private currentState: AppServerClientState = 'disconnected';

  /**
   * 创建并装配一条 Client MessageConnection。
   *
   * Args:
   * - `options`: 完整消息 transport 和单请求超时；超时会关闭连接以清理框架 pending。
   */
  constructor(options: AppServerClientOptions) {
    this.transport = options.transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    ) {
      throw new Error('App Server request timeout must be a positive integer.');
    }
    this.reader = new ClientMessageReader(options.transport);
    this.writer = new ClientMessageWriter(options.transport);
    const strategy = {
      handleMessage: (message, next) => this.handleMessage(message, next),
    } satisfies MessageStrategy;
    this.rpc = createMessageConnection(this.reader, this.writer, undefined, {
      messageStrategy: strategy,
    });
    this.rpc.onRequest((method, params, token) =>
      this.handleServerRequest(method, params, token),
    );
    this.rpc.onNotification((method, params) =>
      this.handleNotification(method, params),
    );
    this.rpc.onError(([error]) => this.fail(error));
    this.rpc.onClose(() => {
      if (this.currentState !== 'closed') {
        this.fail(
          new TransportClosedError('App Server transport ended unexpectedly.'),
        );
      }
    });
  }

  /** 返回当前握手或关闭状态，不改变连接。 */
  get state(): AppServerClientState {
    return this.currentState;
  }

  /**
   * 启动 MessageConnection 的唯一读取循环。
   *
   * Returns:
   * - Promise 在框架进入监听状态后兑现。
   */
  async connect(): Promise<void> {
    if (this.currentState !== 'disconnected') {
      throw new ClientProtocolError(
        `Cannot connect App Server client from ${this.currentState}.`,
      );
    }
    this.rpc.listen();
    this.currentState = 'connected';
  }

  /**
   * 执行 initialize -> initialized 握手。
   *
   * Args:
   * - `params`: Client 版本、能力和协议版本声明。
   *
   * Returns:
   * - 返回经过对应 Zod result schema 校验的 Server 能力。
   */
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
      if (this.closeError === undefined) this.currentState = 'connected';
      throw error;
    }
  }

  /**
   * 发送业务 Client Request。
   *
   * Args:
   * - `method`: 协议 request schema 表中的闭合 method。
   * - `params`: 从 method 派生的 typed 参数。
   *
   * Returns:
   * - 返回经过 method 对应 result schema 校验的结果。
   */
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

  /**
   * 发送经过 Client notification schema 校验的通知。
   *
   * Args:
   * - `method`: 协议 notification schema 表中的闭合 method。
   * - `params`: 从 method 派生的 typed 参数。
   *
   * Returns:
   * - Promise 在框架 Writer 接受通知后兑现。
   */
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

  /**
   * 注册 Server notification listener。
   *
   * Args:
   * - `listener`: 接收已经通过 Zod schema 校验的闭合 notification。
   *
   * Returns:
   * - 返回只移除当前 listener 的函数。
   */
  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /**
   * 注册产品级 Server Request listener。
   *
   * Args:
   * - `listener`: 可按 Thread 归属接管审批或用户输入的 listener。
   *
   * Returns:
   * - 返回只移除当前 listener 的函数。
   */
  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  /**
   * 关闭框架连接和底层 transport。
   *
   * Returns:
   * - Promise 在 Writer 与 transport 生命周期全部结束后兑现；关闭失败直接抛出。
   */
  async close(): Promise<void> {
    await this.beginClose('client closed', false);
    if (this.closeFailure !== undefined) throw this.closeFailure;
  }

  private async requestInternal<M extends ClientMethod>(
    method: M,
    params: ClientParams<M>,
  ): Promise<ClientResult<M>> {
    if (this.closeError !== undefined) throw this.closeError;
    const parsedParams = CLIENT_REQUEST_SCHEMAS[method].parse(params);
    const cancellation = new CancellationTokenSource();
    let rawResult: unknown;
    try {
      const request = this.rpc.sendRequest<unknown>(
        method,
        parsedParams,
        cancellation.token,
      );
      rawResult = await this.waitForRequest(method, request, cancellation);
    } catch (error) {
      throw this.normalizeRequestError(error);
    }
    try {
      return parseClientResult(method, rawResult);
    } catch (error) {
      throw new ResponseValidationError(method, rawResult, { cause: error });
    }
  }

  private notifyInternal<M extends ClientNotificationMethod>(
    method: M,
    params: ClientNotificationParams<M>,
  ): Promise<void> {
    if (this.closeError !== undefined) return Promise.reject(this.closeError);
    const parsedParams = CLIENT_NOTIFICATION_SCHEMAS[method].parse(params);
    return this.rpc.sendNotification(method, parsedParams);
  }

  private waitForRequest(
    method: ClientMethod,
    request: Promise<unknown>,
    cancellation: CancellationTokenSource,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new RequestTimeoutError(method, this.requestTimeoutMs);
        cancellation.cancel();
        cancellation.dispose();
        reject(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      request.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancellation.dispose();
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancellation.dispose();
          reject(error);
        },
      );
    });
  }

  private handleMessage(
    message: Message,
    next: (message: Message) => void | Promise<void>,
  ): Promise<void> {
    const handle = async () => {
      try {
        await next(message);
      } finally {
        this.reader.release(message);
      }
    };
    return Message.isRequest(message)
      ? this.serverRequestContext.run(message.id, handle)
      : handle();
  }

  private handleServerRequest(
    method: string,
    params: object | unknown[] | undefined,
    token: CancellationToken,
  ): Promise<unknown> {
    const id = this.serverRequestContext.getStore();
    if (typeof id !== 'string') {
      throw new ResponseError(
        ErrorCodes.InvalidRequest,
        'Ello Server Request id must be a stable string.',
      );
    }
    if (!isServerRequestMethod(method)) {
      throw new ResponseError(
        ErrorCodes.MethodNotFound,
        `Unknown Server Request ${method}.`,
      );
    }
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'item/tool/requestUserInput':
      case 'item/plan/requestApproval':
        return this.handleTypedServerRequest(
          id,
          method,
          parseServerRequestParams(method, params),
          token,
        );
      default:
        method satisfies never;
        throw new ResponseError(
          ErrorCodes.MethodNotFound,
          `Unknown Server Request ${String(method)}.`,
        );
    }
  }

  private async handleTypedServerRequest<M extends ServerRequestMethod>(
    id: string,
    method: M,
    params: ServerRequestParams<M>,
    token: CancellationToken,
  ): Promise<ServerRequestResult<M>> {
    const settlement = deferred<ServerRequestResult<M>>();
    let settled = false;
    const incoming: IncomingServerRequest<M> = {
      id,
      method,
      params,
      respond: async (result) => {
        if (settled) {
          throw new ClientProtocolError(
            `Server Request ${id} is already resolved.`,
          );
        }
        const parsed = parseServerRequestResult(method, result);
        settled = true;
        settlement.resolve(parsed);
      },
      reject: async (error) => {
        if (settled) {
          throw new ClientProtocolError(
            `Server Request ${id} is already resolved.`,
          );
        }
        settled = true;
        settlement.reject(
          new ResponseError(error.code, error.message, error.data),
        );
      },
    };
    const cancellation = token.onCancellationRequested(() => {
      if (settled) return;
      settled = true;
      settlement.reject(
        new ResponseError(
          ErrorCodes.InternalError,
          `Server Request ${id} was cancelled.`,
        ),
      );
    });
    try {
      for (const listener of this.serverRequestListeners) {
        const claimed = await listener(incoming);
        if (settled || claimed === true) return await settlement.promise;
      }
      settled = true;
      throw new ResponseError(
        ErrorCodes.MethodNotFound,
        `No Client handler accepted ${method}.`,
      );
    } catch (error) {
      settled = true;
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  private handleNotification(
    method: string,
    params: object | unknown[] | undefined,
  ): void {
    try {
      if (!isServerNotificationMethod(method)) {
        throw new ClientProtocolError(
          `Server sent unknown notification ${method}.`,
        );
      }
      // 动态 schema 表已经按同一 method 完成校验；TypeScript 无法保留索引访问后的键值关联。
      const notification = {
        method,
        params: parseServerNotificationParams(method, params),
      } as ServerNotification;
      for (const listener of this.notificationListeners) listener(notification);
    } catch (error) {
      const failure =
        error instanceof Error ? error : new ClientProtocolError(String(error));
      this.fail(failure);
      throw failure;
    }
  }

  private normalizeRequestError(error: unknown): Error {
    if (error instanceof ResponseError) {
      return new ServerResponseError(
        RpcErrorSchema.parse({
          code: error.code,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        }),
      );
    }
    if (this.closeError !== undefined) return this.closeError;
    return error instanceof Error ? error : new Error(String(error));
  }

  private fail(reason: unknown): void {
    if (this.currentState === 'closed') return;
    const error =
      reason instanceof Error
        ? reason
        : new TransportClosedError(String(reason));
    this.closeError = error;
    void this.beginClose(error.message, true);
  }

  private beginClose(reason: string, force: boolean): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask;
    this.currentState = 'closed';
    this.rpc.dispose();
    this.writer.end();
    this.closeTask = this.closeConnection(reason, force);
    return this.closeTask;
  }

  private async closeConnection(reason: string, force: boolean): Promise<void> {
    const operations = force
      ? [this.transport.close(reason), this.writer.drain()]
      : [this.writer.drain().then(() => this.transport.close(reason))];
    const settled = await Promise.allSettled(operations);
    const failures = settled
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result) => result.reason);
    if (failures.length === 0) return;
    this.closeFailure = new AggregateError(
      failures,
      `App Server client close failed: ${reason}`,
    );
    this.closeError =
      this.closeError === undefined
        ? this.closeFailure
        : new AggregateError(
            [this.closeError, this.closeFailure],
            'App Server client failed and could not close cleanly.',
          );
  }
}

function isServerRequestMethod(method: string): method is ServerRequestMethod {
  return Object.hasOwn(SERVER_REQUEST_SCHEMAS, method);
}

function isServerNotificationMethod(
  method: string,
): method is ServerNotificationMethod {
  return Object.hasOwn(SERVER_NOTIFICATION_SCHEMAS, method);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve = (_value: T): void => undefined;
  let reject = (_reason: unknown): void => undefined;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
