/**
 * 本文件负责单条 App Server connection 的 JSON-RPC 连接、协议状态和有界发送顺序。
 *
 * `vscode-jsonrpc` 拥有通用 Request/Response 调度与 Cancellation；Ello 拥有 initialize 状态、稳定
 * Server Request ID、严格 Zod 边界、response-before-notification 屏障和连接级容量预算。
 */
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  Message,
  ResponseError,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Logger,
  type MessageConnection,
  type MessageWriter,
  type MessageStrategy,
  type NotificationMessage,
  type RequestMessage,
  type ResponseMessage,
} from 'vscode-jsonrpc/node';
import { ZodError, type z } from 'zod';

import {
  AppServerError,
  CLIENT_REQUEST_SCHEMAS,
  ELLO_PROTOCOL_VERSION,
  RpcNotificationSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_SCHEMAS,
  parseClientNotificationParams,
  parseClientParams,
  parseClientResult,
  parseServerRequestParams,
  parseServerRequestResult,
  toRpcError,
  type Capability,
  type InitializeResultSchema,
  type ParsedClientParams,
  type PendingServerRequest,
  type RpcRequestId,
  type RpcResponse,
  type ServerNotification,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
} from '../protocol/v1/index.js';

import { dispatchRoute } from './rpc/dispatch.js';
import {
  isRoutableClientMethod,
  RpcPeerUnavailableError,
  type RpcPeer,
  type RpcRouteTable,
} from './rpc/route.js';
import type { AppServerTransport } from './transport/transport.js';

type InitializeResult = z.output<typeof InitializeResultSchema>;

export type ConnectionPhase =
  | 'connected'
  | 'awaitingInitialized'
  | 'ready'
  | 'closed';

export interface RpcConnectionLimits {
  readonly maxMessageBytes: number;
  readonly maxInboundMessages: number;
  readonly maxInboundBytes: number;
  readonly maxOutboundMessages: number;
  readonly maxOutboundBytes: number;
  readonly reservedResponseMessages: number;
  readonly reservedResponseBytes: number;
  readonly backpressureTimeoutMs: number;
}

export const DEFAULT_RPC_CONNECTION_LIMITS = {
  maxMessageBytes: 8 * 1024 * 1024,
  maxInboundMessages: 256,
  maxInboundBytes: 16 * 1024 * 1024,
  maxOutboundMessages: 256,
  maxOutboundBytes: 8 * 1024 * 1024,
  reservedResponseMessages: 32,
  reservedResponseBytes: 1024 * 1024,
  backpressureTimeoutMs: 1_000,
} as const satisfies RpcConnectionLimits;

/** initialize 状态只属于单条连接，不能泄漏到全局 Server。 */
export class ConnectionState {
  phase: ConnectionPhase = 'connected';
  client: ParsedClientParams<'initialize'> | undefined;
  readonly capabilities: ReadonlySet<Capability>;

  /**
   * 创建连接协议状态。
   *
   * Args:
   * - `capabilities`: listener 授予当前连接的闭合 capability 集合。
   */
  constructor(capabilities: ReadonlyArray<Capability>) {
    this.capabilities = new Set(capabilities);
  }

  /**
   * 保存已经通过 Zod 校验的 initialize 参数并进入等待 initialized 阶段。
   *
   * Args:
   * - `params`: 当前连接唯一一次 initialize 的解析结果。
   *
   * Returns:
   * - 状态同步切换完成后返回，不产生 wire 消息。
   */
  initialize(params: ParsedClientParams<'initialize'>): void {
    this.client = params;
    this.phase = 'awaitingInitialized';
  }

  /**
   * 标记 initialize/initialized 握手已经完整完成。
   *
   * Args:
   * - 无：使用当前实例拥有的协议状态。
   *
   * Returns:
   * - 状态切换为 ready 后返回。
   */
  ready(): void {
    this.phase = 'ready';
  }

  /**
   * 标记连接生命周期已经结束。
   *
   * Args:
   * - 无：使用当前实例拥有的协议状态。
   *
   * Returns:
   * - 状态切换为 closed 后返回。
   */
  close(): void {
    this.phase = 'closed';
  }
}

interface PendingRequest {
  resolveResult(value: unknown): void;
  readonly reject: (reason: unknown) => void;
}

/**
 * 发送一条已经携带稳定领域 ID 的 Server Request。
 *
 * Args:
 * - `message`: 经过 method params schema 校验的完整 RequestMessage。
 *
 * Returns:
 * - Promise 在消息进入协议 Writer 并满足其背压约束后兑现。
 */
type SendPersistentServerRequest = (message: RequestMessage) => Promise<void>;

/** 持久化 Server Request 使用领域 ID，连接重建后仍能用同一 ID 重新派发。 */
export class PersistentServerRequests {
  private readonly pending = new Map<string, PendingRequest>();

  /**
   * 创建稳定 Server Request broker。
   *
   * Args:
   * - `send`: 把已经包含领域 ID 的 RequestMessage 交给协议 Writer 的函数。
   */
  constructor(private readonly send: SendPersistentServerRequest) {}

  /**
   * 发送带稳定领域 ID 的 Server Request，并等待当前连接返回结果。
   *
   * Args:
   * - `id`: Thread record 中持久化的 `srvreq_*` ID，同时作为 JSON-RPC wire ID。
   * - `method`: Server Request schema 表中的闭合 method。
   * - `params`: 已经按 method 派生的产品参数。
   *
   * Returns:
   * - Promise 在匹配 response 到达并通过 result schema 后兑现。
   */
  request<TMethod extends ServerRequestMethod>(
    id: string,
    method: TMethod,
    params: ServerRequestParams<TMethod>,
  ): Promise<ServerRequestResult<TMethod>> {
    if (this.pending.has(id)) {
      return Promise.reject(
        new AppServerError({
          type: 'invalidRequest',
          message: `Duplicate Server Request id ${id}.`,
        }),
      );
    }
    return new Promise<ServerRequestResult<TMethod>>((resolve, reject) => {
      this.pending.set(id, {
        resolveResult: (value) =>
          resolve(parseServerRequestResult(method, value)),
        reject,
      });
      void this.send({ jsonrpc: '2.0', id, method, params }).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /**
   * 用 Client 返回的稳定 wire ID 完成唯一 pending Server Request。
   *
   * Args:
   * - `response`: 已通过严格 JSON-RPC response schema 的 Client 消息。
   *
   * Returns:
   * - pending Promise 完成或拒绝后同步返回。
   */
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
      pending.resolveResult(response.result);
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

  /**
   * 连接结束时拒绝全部 pending Server Request。
   *
   * Args:
   * - `error`: 表示当前 peer 不再可用的明确失败原因。
   *
   * Returns:
   * - pending map 清空后返回。
   */
  disconnect(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

interface EncodedMessage {
  readonly message: Message;
  readonly bytes: Uint8Array;
  readonly response: boolean;
}

interface AdmissionWaiter {
  readonly encoded: EncodedMessage;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

interface ResponseBarrier {
  readonly id: RpcRequestId;
  readonly held: EncodedMessage[];
}

/**
 * 单一 Writer 同时拥有 response barrier、发送串行化和完整容量预算。
 *
 * outbox 中的消息在进入数组前已经占用预算，因此不会绕过 maxMessages/maxBytes。
 */
export class ProtocolMessageWriter
  extends AbstractMessageWriter
  implements MessageWriter
{
  private readonly encoder = new TextEncoder();
  private sendQueue: Promise<void> = Promise.resolve();
  private barrier: ResponseBarrier | undefined;
  private totalMessages = 0;
  private totalBytes = 0;
  private ordinaryMessages = 0;
  private ordinaryBytes = 0;
  private readonly responseWaiters: AdmissionWaiter[] = [];
  private readonly ordinaryWaiters: AdmissionWaiter[] = [];
  private accepting = true;

  /**
   * 创建带顺序屏障和容量预算的协议 Writer。
   *
   * Args:
   * - `transport`: 搬运完整 UTF-8 JSON 消息的底层 transport。
   * - `limits`: 当前连接统一使用的消息数、字节数和超时约束。
   * - `onFailure`: Writer 无法继续保证顺序时关闭整条连接的回调。
   */
  constructor(
    private readonly transport: AppServerTransport,
    private readonly limits: RpcConnectionLimits,
    private readonly onFailure: (error: Error) => void,
  ) {
    super();
    assertConnectionLimits(limits);
  }

  /**
   * 在 Client Request handler 开始前建立唯一 response barrier。
   *
   * Args:
   * - `id`: 当前 Client Request 的 JSON-RPC ID；后续只有匹配 response 能释放 outbox。
   *
   * Returns:
   * - barrier 建立后返回。
   */
  beginResponseBarrier(id: RpcRequestId): void {
    if (this.barrier !== undefined) {
      throw new Error('Connection already has an active response barrier.');
    }
    this.barrier = { id, held: [] };
  }

  /**
   * 串行发送消息；匹配 response 必须先落到 transport，再释放 barrier 内消息。
   *
   * Args:
   * - `message`: `vscode-jsonrpc` 产生或 Ello 主动发送的完整 JSON-RPC 消息。
   *
   * Returns:
   * - 直接消息在 transport send 完成后兑现；barrier 内普通消息在成功占用预算后立即兑现。
   */
  write(message: Message): Promise<void> {
    if (!this.accepting) {
      return Promise.reject(new Error('Protocol writer is closed.'));
    }
    let encoded: EncodedMessage;
    try {
      encoded = this.encode(message);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.onFailure(failure);
      return Promise.reject(failure);
    }
    return this.admit(encoded).then(() => this.writeAdmitted(encoded));
  }

  private writeAdmitted(encoded: EncodedMessage): Promise<void> {
    const barrier = this.barrier;
    if (
      barrier !== undefined &&
      !isBarrierResponse(encoded.message, barrier.id)
    ) {
      barrier.held.push(encoded);
      return Promise.resolve();
    }
    if (barrier === undefined) return this.schedule(encoded);

    this.barrier = undefined;
    let completion = this.schedule(encoded);
    for (const held of barrier.held) completion = this.schedule(held);
    return completion;
  }

  /**
   * 标记 Writer 生命周期结束；`MessageConnection.end()` 不负责关闭底层 transport。
   *
   * Args:
   * - 无：使用 Writer 已持有的连接状态。
   *
   * Returns:
   * - 标记完成后同步返回。
   */
  end(): void {
    this.stopAccepting();
  }

  /**
   * 禁止新消息进入并释放尚未发送的 barrier 预算。
   *
   * Args:
   * - 无：使用 Writer 已持有的连接状态。
   *
   * Returns:
   * - 未调度 outbox 清理完成后返回。
   */
  stopAccepting(): void {
    if (!this.accepting) return;
    this.accepting = false;
    const closeError = new Error('Protocol writer is closed.');
    for (const waiter of [
      ...this.responseWaiters.splice(0),
      ...this.ordinaryWaiters.splice(0),
    ]) {
      clearTimeout(waiter.timer);
      waiter.reject(closeError);
    }
    const held = this.barrier?.held ?? [];
    this.barrier = undefined;
    for (const message of held) this.release(message);
    this.fireClose();
  }

  /**
   * 等待所有已经进入底层发送链的消息完成。
   *
   * Args:
   * - 无：等待当前 Writer 的稳定 send queue。
   *
   * Returns:
   * - Promise 在队列全部完成或已经转换为连接失败后兑现。
   */
  drain(): Promise<void> {
    return this.sendQueue;
  }

  private encode(message: Message): EncodedMessage {
    const bytes = this.encoder.encode(JSON.stringify(message));
    if (bytes.byteLength > this.limits.maxMessageBytes) {
      throw new AppServerError({
        type: 'serverOverloaded',
        message: `Outgoing JSON-RPC message exceeds ${this.limits.maxMessageBytes} bytes.`,
      });
    }
    return { message, bytes, response: Message.isResponse(message) };
  }

  private admit(encoded: EncodedMessage): Promise<void> {
    if (this.canAdmit(encoded)) {
      this.reserve(encoded);
      return Promise.resolve();
    }
    if (
      !encoded.response &&
      this.responseWaiters.length + this.ordinaryWaiters.length >=
        this.limits.maxOutboundMessages
    ) {
      const error = new AppServerError({
        type: 'serverOverloaded',
        message: `Connection outbound backpressure exceeds ${this.limits.maxOutboundMessages} waiting messages.`,
      });
      this.onFailure(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = encoded.response
          ? this.responseWaiters
          : this.ordinaryWaiters;
        const index = queue.indexOf(waiter);
        if (index === -1) return;
        queue.splice(index, 1);
        const error = new AppServerError({
          type: 'serverOverloaded',
          message: `Connection outbound queue remained full for ${this.limits.backpressureTimeoutMs} ms.`,
        });
        waiter.reject(error);
        this.onFailure(error);
      }, this.limits.backpressureTimeoutMs);
      timer.unref();
      const waiter: AdmissionWaiter = { encoded, resolve, reject, timer };
      (encoded.response ? this.responseWaiters : this.ordinaryWaiters).push(
        waiter,
      );
    });
  }

  private canAdmit(encoded: EncodedMessage): boolean {
    const nextTotalMessages = this.totalMessages + 1;
    const nextTotalBytes = this.totalBytes + encoded.bytes.byteLength;
    const nextOrdinaryMessages =
      this.ordinaryMessages + (encoded.response ? 0 : 1);
    const nextOrdinaryBytes =
      this.ordinaryBytes + (encoded.response ? 0 : encoded.bytes.byteLength);
    return !(
      nextTotalMessages > this.limits.maxOutboundMessages ||
      nextTotalBytes > this.limits.maxOutboundBytes ||
      nextOrdinaryMessages >
        this.limits.maxOutboundMessages -
          this.limits.reservedResponseMessages ||
      nextOrdinaryBytes >
        this.limits.maxOutboundBytes - this.limits.reservedResponseBytes
    );
  }

  private reserve(encoded: EncodedMessage): void {
    this.totalMessages += 1;
    this.totalBytes += encoded.bytes.byteLength;
    if (!encoded.response) {
      this.ordinaryMessages += 1;
      this.ordinaryBytes += encoded.bytes.byteLength;
    }
  }

  private schedule(encoded: EncodedMessage): Promise<void> {
    const operation = this.sendQueue.then(() =>
      withTimeout(
        this.transport.send(encoded.bytes),
        this.limits.backpressureTimeoutMs,
        'JSON-RPC transport backpressure timed out.',
      ),
    );
    this.sendQueue = operation.then(
      () => this.release(encoded),
      (error: unknown) => {
        this.release(encoded);
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.fireError(failure, encoded.message);
        this.onFailure(failure);
      },
    );
    return operation;
  }

  private release(encoded: EncodedMessage): void {
    this.totalMessages -= 1;
    this.totalBytes -= encoded.bytes.byteLength;
    if (!encoded.response) {
      this.ordinaryMessages -= 1;
      this.ordinaryBytes -= encoded.bytes.byteLength;
    }
    this.drainAdmissionWaiters();
  }

  private drainAdmissionWaiters(): void {
    if (!this.accepting) return;
    while (this.responseWaiters.length > 0) {
      const waiter = this.responseWaiters[0];
      if (waiter === undefined || !this.canAdmit(waiter.encoded)) return;
      this.responseWaiters.shift();
      clearTimeout(waiter.timer);
      this.reserve(waiter.encoded);
      waiter.resolve();
    }
    while (this.ordinaryWaiters.length > 0) {
      const waiter = this.ordinaryWaiters[0];
      if (waiter === undefined || !this.canAdmit(waiter.encoded)) return;
      this.ordinaryWaiters.shift();
      clearTimeout(waiter.timer);
      this.reserve(waiter.encoded);
      waiter.resolve();
    }
  }
}

interface ReaderLimits {
  readonly maxMessageBytes: number;
  readonly maxInboundMessages: number;
  readonly maxInboundBytes: number;
}

class TransportMessageReader extends AbstractMessageReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly admitted = new Map<Message, number>();
  private callback: DataCallback | undefined;
  private started = false;
  private inboundMessages = 0;
  private inboundBytes = 0;
  private resolveFinished: () => void = () => undefined;
  private rejectFinished: (error: unknown) => void = () => undefined;
  readonly finished: Promise<void>;

  constructor(
    private readonly transport: AppServerTransport,
    private readonly limits: ReaderLimits,
    private readonly writer: ProtocolMessageWriter,
    private readonly persistentRequests: PersistentServerRequests,
  ) {
    super();
    this.finished = new Promise((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
  }

  listen(callback: DataCallback): Disposable {
    if (this.started) throw new Error('Message reader may only listen once.');
    this.started = true;
    this.callback = callback;
    void this.readMessages().then(this.resolveFinished, this.rejectFinished);
    return {
      dispose: () => {
        if (this.callback === callback) this.callback = undefined;
      },
    };
  }

  release(message: Message): void {
    const bytes = this.admitted.get(message);
    if (bytes === undefined) return;
    this.admitted.delete(message);
    this.inboundMessages -= 1;
    this.inboundBytes -= bytes;
  }

  private async readMessages(): Promise<void> {
    try {
      for await (const bytes of this.transport.messages()) {
        await this.processBytes(bytes);
      }
      this.fireClose();
    } catch (error) {
      this.fireError(error);
      throw error;
    }
  }

  private async processBytes(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > this.limits.maxMessageBytes) {
      throw new AppServerError({
        type: 'serverOverloaded',
        message: `Incoming JSON-RPC message exceeds ${this.limits.maxMessageBytes} bytes.`,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(this.decoder.decode(bytes));
    } catch (error) {
      await this.sendProtocolError(
        null,
        new AppServerError({
          type: 'parseError',
          message: 'Invalid JSON.',
          cause: error,
        }),
      );
      return;
    }

    const response = RpcResponseSchema.safeParse(value);
    if (response.success) {
      this.persistentRequests.resolve(response.data);
      return;
    }
    const request = RpcRequestSchema.safeParse(value);
    if (request.success) {
      this.deliver(
        {
          jsonrpc: '2.0',
          id: request.data.id,
          method: request.data.method,
          params: request.data.params,
        },
        bytes.byteLength,
      );
      return;
    }
    const notification = RpcNotificationSchema.safeParse(value);
    if (notification.success) {
      this.deliver(
        {
          jsonrpc: '2.0',
          method: notification.data.method,
          params: notification.data.params,
        },
        bytes.byteLength,
      );
      return;
    }
    await this.sendProtocolError(
      requestIdFrom(value),
      new AppServerError({
        type: 'invalidRequest',
        message: 'Invalid JSON-RPC request.',
        details: { issues: request.error.issues },
      }),
    );
  }

  private deliver(
    message: RequestMessage | NotificationMessage,
    bytes: number,
  ) {
    const callback = this.callback;
    if (callback === undefined) {
      throw new Error(
        'Message reader received data without an active listener.',
      );
    }
    if (
      Message.isNotification(message) &&
      message.method === '$/cancelRequest'
    ) {
      callback(message);
      return;
    }
    if (
      this.inboundMessages + 1 > this.limits.maxInboundMessages ||
      this.inboundBytes + bytes > this.limits.maxInboundBytes
    ) {
      throw new AppServerError({
        type: 'serverOverloaded',
        message: `Connection inbound queue exceeds ${this.limits.maxInboundMessages} messages or ${this.limits.maxInboundBytes} bytes.`,
      });
    }
    this.inboundMessages += 1;
    this.inboundBytes += bytes;
    this.admitted.set(message, bytes);
    try {
      callback(message);
    } catch (error) {
      this.release(message);
      throw error;
    }
  }

  private sendProtocolError(
    id: RpcRequestId | null,
    error: AppServerError,
  ): Promise<void> {
    const message: ResponseMessage = {
      jsonrpc: '2.0',
      id,
      error: toRpcError(error),
    };
    return this.writer.write(message);
  }
}

export interface ServerConnectionOptions {
  readonly routes: RpcRouteTable;
  readonly version: string;
  readonly transports: ReadonlyArray<'stdio' | 'websocket' | 'unix'>;
  readonly limits?: RpcConnectionLimits;
  readonly log: (
    event: string,
    details: Readonly<Record<string, unknown>>,
  ) => void;
}

/** 单连接协议编排层；Feature 只能通过 `RpcPeer` 使用通知和稳定 Server Request。 */
export class ServerConnection implements RpcPeer {
  readonly id: string;
  readonly state: ConnectionState;
  readonly persistentRequests: PersistentServerRequests;
  private readonly writer: ProtocolMessageWriter;
  private readonly reader: TransportMessageReader;
  private readonly rpc: MessageConnection;
  private closeTask: Promise<void> | undefined;
  private closeAfterMessage: string | undefined;
  private fatalError: Error | undefined;

  /**
   * 创建并装配一条 `vscode-jsonrpc` MessageConnection。
   *
   * Args:
   * - `transport`: 已完成 framing 的字节 transport，每次迭代只产生一条完整 JSON-RPC 消息。
   * - `capabilities`: listener 授予当前连接的 capability。
   * - `options`: typed routes、版本、transport 声明、容量预算和结构化日志入口。
   */
  constructor(
    private readonly transport: AppServerTransport,
    capabilities: ReadonlyArray<Capability>,
    private readonly options: ServerConnectionOptions,
  ) {
    this.id = transport.connectionId;
    this.state = new ConnectionState(capabilities);
    const limits = options.limits ?? DEFAULT_RPC_CONNECTION_LIMITS;
    this.writer = new ProtocolMessageWriter(transport, limits, (error) =>
      this.fail(error),
    );
    this.persistentRequests = new PersistentServerRequests((message) =>
      this.writer.write(message),
    );
    this.reader = new TransportMessageReader(
      transport,
      limits,
      this.writer,
      this.persistentRequests,
    );
    const strategy = {
      handleMessage: (message, next) => this.handleMessage(message, next),
    } satisfies MessageStrategy;
    this.rpc = createMessageConnection(
      this.reader,
      this.writer,
      createConnectionLogger(options.log),
      { maxParallelism: 1, messageStrategy: strategy },
    );
    this.rpc.onRequest((method, params, token) =>
      this.handleRequest(method, params, token),
    );
    this.rpc.onNotification((method, params) =>
      this.handleNotification(method, params),
    );
    this.rpc.onError(([error]) => this.fail(error));
  }

  /**
   * 读取当前 transport kind。
   *
   * Returns:
   * - 返回 stdio、websocket 或 unix，不改变连接状态。
   */
  get kind(): AppServerTransport['kind'] {
    return this.transport.kind;
  }

  /**
   * 读取当前连接稳定 ID。
   *
   * Returns:
   * - 返回 transport 创建时分配的 connection ID。
   */
  get connectionId(): string {
    return this.id;
  }

  /**
   * 读取 listener 授予当前连接的 capability 集合。
   *
   * Returns:
   * - 返回只读 capability 集合。
   */
  get capabilities(): ReadonlySet<Capability> {
    return this.state.capabilities;
  }

  /**
   * 判断当前连接是否能控制持久化 Server Request。
   *
   * Returns:
   * - 同时具备 approve capability 且 Client 声明支持 Server Request 时返回 true。
   */
  get supportsServerRequests(): boolean {
    return (
      this.capabilities.has('approve') &&
      this.state.client?.capabilities.supportsServerRequests === true
    );
  }

  /**
   * 启动 MessageConnection 并等待 transport 结束。
   *
   * Args:
   * - 无：使用构造阶段已经完成装配的 reader、writer 和 route registry。
   *
   * Returns:
   * - Promise 在连接关闭、pending request 清理和 transport 释放后兑现。
   */
  async run(): Promise<void> {
    this.rpc.listen();
    let failure: unknown;
    try {
      await this.reader.finished;
      if (this.fatalError !== undefined) failure = this.fatalError;
    } catch (error) {
      failure = error;
    }
    try {
      await this.close('transport ended', failure !== undefined);
    } catch (closeError) {
      failure =
        failure === undefined
          ? closeError
          : new AggregateError(
              [failure, closeError],
              'Connection processing and close both failed.',
              { cause: closeError },
            );
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * 发送已经通过产品 notification schema 的消息。
   *
   * Args:
   * - `notification`: Feature 产生的闭合 ServerNotification 联合。
   *
   * Returns:
   * - Promise 在消息占用 outbox 预算或完成底层发送后兑现。
   */
  notify(notification: ServerNotification): Promise<void> {
    const message: NotificationMessage = {
      jsonrpc: '2.0',
      ...notification,
    };
    return this.writer.write(message);
  }

  /**
   * 发送使用持久化领域 ID 的 Server Request。
   *
   * Args:
   * - `request`: Thread snapshot/record 中的完整 pending request。
   *
   * Returns:
   * - Promise 在匹配 Client response 通过 result schema 后兑现。
   */
  request(request: PendingServerRequest): Promise<unknown> {
    return requestPersistentServerRequest(this.persistentRequests, request);
  }

  /**
   * 停止连接并释放 pending request、MessageConnection、Writer 和 transport。
   *
   * Args:
   * - `reason`: 可观察的关闭原因。
   * - `force`: true 表示过载或传输失败，不等待正常发送队列；省略时执行优雅关闭。
   *
   * Returns:
   * - Promise 在当前连接拥有的全部资源完成释放后兑现。
   */
  close(reason: string, force = false): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask;
    this.closeTask = this.closeConnection(reason, force);
    return this.closeTask;
  }

  private async closeConnection(reason: string, force: boolean): Promise<void> {
    this.state.close();
    this.persistentRequests.disconnect(
      new RpcPeerUnavailableError(`Connection closed: ${reason}`),
    );
    this.rpc.dispose();
    this.writer.stopAccepting();
    if (!force) await this.writer.drain();
    await this.transport.close(reason, force);
  }

  private handleMessage(
    message: Message,
    next: (message: Message) => void | Promise<void>,
  ): Promise<void> {
    try {
      if (Message.isRequest(message)) {
        if (message.id === null) {
          throw new Error('Ello Client Request ID cannot be null.');
        }
        this.writer.beginResponseBarrier(message.id);
      }
      return Promise.resolve(next(message)).finally(async () => {
        this.reader.release(message);
        const closeReason = this.closeAfterMessage;
        this.closeAfterMessage = undefined;
        if (closeReason !== undefined) await this.close(closeReason);
      });
    } catch (error) {
      this.reader.release(message);
      return Promise.reject(error);
    }
  }

  private async handleRequest(
    method: string,
    params: object | unknown[] | undefined,
    _token: import('vscode-jsonrpc/node').CancellationToken,
  ): Promise<unknown> {
    try {
      const rawParams: unknown = params;
      if (method === 'initialize') return this.initialize(rawParams);
      if (this.state.phase !== 'ready') {
        throw new AppServerError({
          type: 'notInitialized',
          message: 'Connection has not completed initialize/initialized.',
        });
      }
      if (!isRoutableClientMethod(method)) {
        throw new AppServerError({
          type: 'methodNotFound',
          message: `Unknown method ${method}.`,
          details: { method },
        });
      }
      return await dispatchRoute(this.options.routes, this, method, rawParams);
    } catch (error) {
      if (error instanceof ResponseError) throw error;
      throw responseError(normalizeRpcError(error));
    }
  }

  private async handleNotification(
    method: string,
    params: object | unknown[] | undefined,
  ): Promise<void> {
    if (method !== 'initialized') {
      await this.close(`Unknown Client notification ${method}.`);
      return;
    }
    if (this.state.phase !== 'awaitingInitialized') {
      await this.close('initialized notification is out of order.');
      return;
    }
    parseClientNotificationParams('initialized', params);
    this.state.ready();
    await this.notify({
      method: 'server/ready',
      params: { protocolVersion: ELLO_PROTOCOL_VERSION },
    });
  }

  /**
   * 校验唯一一次 initialize 并返回 Server 能力声明。
   *
   * Args:
   * - `params`: 尚未信任的 initialize wire params。
   *
   * Returns:
   * - 返回通过 initialize result schema 校验的协议版本、Server 信息和能力集合。
   */
  private initialize(params: unknown): InitializeResult {
    if (this.state.phase !== 'connected') {
      throw new AppServerError({
        type: 'alreadyInitialized',
        message: 'initialize may only be sent once.',
      });
    }
    const rawVersion = readProperty(params, 'protocolVersion');
    if (rawVersion !== ELLO_PROTOCOL_VERSION) {
      const error = new AppServerError({
        type: 'protocolMismatch',
        message: `Unsupported protocol version ${String(rawVersion)}.`,
        details: { supported: ELLO_PROTOCOL_VERSION, received: rawVersion },
      });
      this.closeAfterMessage = error.message;
      throw error;
    }
    const parsed = parseInitializeParams(params);
    this.state.initialize(parsed);
    return parseClientResult('initialize', {
      protocolVersion: ELLO_PROTOCOL_VERSION,
      serverInfo: { name: 'ello-agent', version: this.options.version },
      serverCapabilities: {
        transports: this.options.transports,
        methods: Object.keys(CLIENT_REQUEST_SCHEMAS),
        notifications: Object.keys(SERVER_NOTIFICATION_SCHEMAS),
        serverRequests: Object.keys(SERVER_REQUEST_SCHEMAS),
        granted: [...this.capabilities],
      },
    });
  }

  private fail(error: Error): void {
    if (this.fatalError === undefined) this.fatalError = error;
    void this.close(error.message, true).catch((closeError: unknown) => {
      this.fatalError = new AggregateError(
        [error, closeError],
        'Connection failure and forced close both failed.',
        { cause: closeError },
      );
    });
  }
}

function requestPersistentServerRequest(
  persistent: PersistentServerRequests,
  request: PendingServerRequest,
): Promise<unknown> {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval':
    case 'item/tool/requestUserInput':
    case 'item/plan/requestApproval':
      return persistent.request(
        request.id,
        request.method,
        parseServerRequestParams(request.method, request.params),
      );
    default:
      throw new AppServerError({
        type: 'invalidRequest',
        message: `Unknown persisted Server Request method ${request.method}.`,
      });
  }
}

function parseInitializeParams(
  params: unknown,
): ParsedClientParams<'initialize'> {
  try {
    return parseClientParams('initialize', params);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new AppServerError({
      type: 'invalidParams',
      message: 'Request params do not match the protocol schema.',
      details: { method: 'initialize', issues: error.issues },
      cause: error,
    });
  }
}

function normalizeRpcError(error: unknown): AppServerError {
  if (error instanceof AppServerError) return error;
  return new AppServerError({
    type: 'internal',
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

function responseError(error: AppServerError): ResponseError<unknown> {
  const rpcError = toRpcError(error);
  return new ResponseError(rpcError.code, rpcError.message, rpcError.data);
}

function requestIdFrom(value: unknown): RpcRequestId | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function readProperty(value: unknown, property: string): unknown {
  return isRecord(value) ? value[property] : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBarrierResponse(message: Message, id: RpcRequestId): boolean {
  return Message.isResponse(message) && message.id === id;
}

function assertConnectionLimits(limits: RpcConnectionLimits): void {
  const values = Object.values(limits);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('RPC connection limits must be positive safe integers.');
  }
  if (
    limits.reservedResponseMessages >= limits.maxOutboundMessages ||
    limits.reservedResponseBytes >= limits.maxOutboundBytes
  ) {
    throw new Error(
      'Response reservation must be smaller than total capacity.',
    );
  }
}

function createConnectionLogger(log: ServerConnectionOptions['log']): Logger {
  return {
    error: (message) => log('jsonrpc.error', { message }),
    warn: (message) => log('jsonrpc.warning', { message }),
    info: (message) => log('jsonrpc.info', { message }),
    log: (message) => log('jsonrpc.trace', { message }),
  };
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
