/**
 * 本文件定义 TUI 的完整消息 transport port，并把它适配为 `vscode-jsonrpc` Reader/Writer。
 *
 * transport 只负责 framing 和字节搬运；本文件统一执行 JSON 解码、严格 envelope 校验、发送串行化与
 * 连接级容量预算，stdio、WebSocket、Unix socket 不得各自复制 RPC 解析逻辑。
 */
import { RpcMessageSchema, type RpcMessage } from '@ello/agent/protocol';
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type NotificationMessage,
  type RequestMessage,
  type ResponseMessage,
} from 'vscode-jsonrpc/node';

import { ClientProtocolError, TransportClosedError } from './request-errors.js';

export type ClientTransportKind = 'stdio' | 'websocket' | 'unix' | 'memory';

/**
 * Client 只依赖消息 transport；stdio、WebSocket 与 Unix socket 不得各自解析 RPC。
 */
export interface ClientTransport {
  readonly kind: ClientTransportKind;
  /** 返回按 transport framing 切分后的完整消息流。 */
  messages(): AsyncIterable<Uint8Array>;
  /** 发送一条完整消息，并在底层接受字节后兑现。 */
  send(message: Uint8Array): Promise<void>;
  /** 关闭 transport 及其拥有的 I/O 资源。 */
  close(reason?: string): Promise<void>;
}

interface ClientRpcLimits {
  readonly maxMessageBytes: number;
  readonly maxInboundMessages: number;
  readonly maxInboundBytes: number;
  readonly maxOutboundMessages: number;
  readonly maxOutboundBytes: number;
}

const CLIENT_RPC_LIMITS = {
  maxMessageBytes: 8 * 1024 * 1024,
  maxInboundMessages: 256,
  maxInboundBytes: 16 * 1024 * 1024,
  maxOutboundMessages: 256,
  maxOutboundBytes: 16 * 1024 * 1024,
} as const satisfies ClientRpcLimits;

/** transport 字节流到严格 JSON-RPC Message 的唯一 Client 侧适配器。 */
export class ClientMessageReader extends AbstractMessageReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly admitted = new Map<Message, number>();
  private callback: DataCallback | undefined;
  private started = false;
  private inboundMessages = 0;
  private inboundBytes = 0;

  /**
   * 创建 Client MessageReader。
   *
   * Args:
   * - `transport`: 每次迭代只产生一条完整 JSON-RPC 消息的底层 transport。
   */
  constructor(private readonly transport: ClientTransport) {
    super();
  }

  /**
   * 启动唯一读取循环。
   *
   * Args:
   * - `callback`: `MessageConnection` 提供的消息接收入口。
   *
   * Returns:
   * - 返回可停止向框架投递消息的 disposable。
   */
  listen(callback: DataCallback): Disposable {
    if (this.started)
      throw new Error('Client MessageReader may only listen once.');
    this.started = true;
    this.callback = callback;
    void this.readMessages();
    return {
      dispose: () => {
        if (this.callback === callback) this.callback = undefined;
      },
    };
  }

  /**
   * 在框架完成消息处理后释放其连接级 inbound 预算。
   *
   * Args:
   * - `message`: 此前由当前 Reader 投递的同一对象。
   *
   * Returns:
   * - 对应消息存在时释放预算后返回；重复释放不改变计数。
   */
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
        this.deliver(this.parse(bytes), bytes.byteLength);
      }
      this.fireClose();
    } catch (error) {
      this.fireError(
        error instanceof Error ? error : new ClientProtocolError(String(error)),
      );
    }
  }

  private parse(bytes: Uint8Array): Message {
    if (bytes.byteLength > CLIENT_RPC_LIMITS.maxMessageBytes) {
      throw new ClientProtocolError(
        `Server message exceeds ${CLIENT_RPC_LIMITS.maxMessageBytes} bytes.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(this.decoder.decode(bytes));
    } catch (error) {
      throw new ClientProtocolError('Server sent malformed JSON.', {
        cause: error,
      });
    }
    const parsed = RpcMessageSchema.safeParse(value);
    if (!parsed.success) {
      throw new ClientProtocolError(
        'Server sent an invalid JSON-RPC message.',
        { cause: parsed.error },
      );
    }
    return toFrameworkMessage(parsed.data);
  }

  private deliver(message: Message, bytes: number): void {
    const callback = this.callback;
    if (callback === undefined) {
      throw new TransportClosedError(
        'Server sent a message after the Client reader stopped.',
      );
    }
    if (
      this.inboundMessages + 1 > CLIENT_RPC_LIMITS.maxInboundMessages ||
      this.inboundBytes + bytes > CLIENT_RPC_LIMITS.maxInboundBytes
    ) {
      throw new ClientProtocolError(
        `Client inbound queue exceeds ${CLIENT_RPC_LIMITS.maxInboundMessages} messages or ${CLIENT_RPC_LIMITS.maxInboundBytes} bytes.`,
      );
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
}

interface EncodedMessage {
  readonly message: Message;
  readonly bytes: Uint8Array;
}

/** Client 侧唯一串行 Writer；所有 transport 共享相同消息数与 UTF-8 字节预算。 */
export class ClientMessageWriter extends AbstractMessageWriter {
  private readonly encoder = new TextEncoder();
  private sendQueue: Promise<void> = Promise.resolve();
  private queuedMessages = 0;
  private queuedBytes = 0;
  private accepting = true;

  /**
   * 创建 Client MessageWriter。
   *
   * Args:
   * - `transport`: 接收完整 UTF-8 JSON 消息的底层 transport。
   */
  constructor(private readonly transport: ClientTransport) {
    super();
  }

  /**
   * 验证容量并按调用顺序发送一条框架消息。
   *
   * Args:
   * - `message`: `MessageConnection` 生成的 Request、Notification 或 Response。
   *
   * Returns:
   * - Promise 在底层 transport 接受完整消息后兑现。
   */
  write(message: Message): Promise<void> {
    if (!this.accepting) {
      return Promise.reject(new TransportClosedError());
    }
    let encoded: EncodedMessage;
    try {
      encoded = this.encode(message);
      this.admit(encoded);
    } catch (error) {
      const failure =
        error instanceof Error ? error : new ClientProtocolError(String(error));
      this.fireError(failure, message);
      return Promise.reject(failure);
    }
    const operation = this.sendQueue.then(() =>
      this.transport.send(encoded.bytes),
    );
    this.sendQueue = operation.then(
      () => this.release(encoded),
      (error: unknown) => {
        this.release(encoded);
        const failure =
          error instanceof Error
            ? error
            : new TransportClosedError(String(error));
        this.fireError(failure, encoded.message);
      },
    );
    return operation;
  }

  /**
   * 停止接受新消息；已经排入发送链的消息仍可由 `drain()` 等待。
   *
   * Returns:
   * - Writer 状态切换完成后返回。
   */
  end(): void {
    this.accepting = false;
    this.fireClose();
  }

  /**
   * 等待所有已经进入 Writer 的发送操作完成。
   *
   * Returns:
   * - Promise 在稳定 send queue 清空后兑现。
   */
  drain(): Promise<void> {
    return this.sendQueue;
  }

  private encode(message: Message): EncodedMessage {
    const bytes = this.encoder.encode(JSON.stringify(message));
    if (bytes.byteLength > CLIENT_RPC_LIMITS.maxMessageBytes) {
      throw new ClientProtocolError(
        `Client message exceeds ${CLIENT_RPC_LIMITS.maxMessageBytes} bytes.`,
      );
    }
    return { message, bytes };
  }

  private admit(encoded: EncodedMessage): void {
    if (
      this.queuedMessages + 1 > CLIENT_RPC_LIMITS.maxOutboundMessages ||
      this.queuedBytes + encoded.bytes.byteLength >
        CLIENT_RPC_LIMITS.maxOutboundBytes
    ) {
      throw new ClientProtocolError(
        `Client outbound queue exceeds ${CLIENT_RPC_LIMITS.maxOutboundMessages} messages or ${CLIENT_RPC_LIMITS.maxOutboundBytes} bytes.`,
      );
    }
    this.queuedMessages += 1;
    this.queuedBytes += encoded.bytes.byteLength;
  }

  private release(encoded: EncodedMessage): void {
    this.queuedMessages -= 1;
    this.queuedBytes -= encoded.bytes.byteLength;
  }
}

function toFrameworkMessage(message: RpcMessage): Message {
  if ('method' in message) {
    if ('id' in message) {
      const request: RequestMessage = {
        jsonrpc: '2.0',
        id: message.id,
        method: message.method,
        params: message.params,
      };
      return request;
    }
    const notification: NotificationMessage = {
      jsonrpc: '2.0',
      method: message.method,
      params: message.params,
    };
    return notification;
  }
  if ('error' in message) {
    const response: ResponseMessage = {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: message.error.code,
        message: message.error.message,
        ...(message.error.data === undefined
          ? {}
          : { data: message.error.data }),
      },
    };
    return response;
  }
  // `JSON.parse` 是唯一输入源，成功响应的 result 因此必然属于 JSON-RPC 支持的 JSON 值。
  const result = message.result as Exclude<
    ResponseMessage['result'],
    undefined
  >;
  const response: ResponseMessage = {
    jsonrpc: '2.0',
    id: message.id,
    result,
  };
  return response;
}
