/**
 * WebSocket 与 Unix socket 共用一套 Client framing、有限 inbound queue、发送背压和关闭生命周期。
 *
 * 两种 endpoint 只在 socket 建立方式上不同；一帧始终是一条完整 JSON-RPC 消息。
 */
import { createConnection } from 'node:net';

import WebSocket, { type ClientOptions } from 'ws';

import type { ClientTransport, ClientTransportKind } from '../transport.js';

import { AsyncByteQueue } from './async-byte-queue.js';

const CLOSE_TIMEOUT_MS = 1_000;
const SEND_HIGH_WATER_BYTES = 1024 * 1024;
const SEND_LOW_WATER_BYTES = 512 * 1024;

class SocketClientTransport implements ClientTransport {
  private readonly incoming = new AsyncByteQueue();
  private closed = false;

  /**
   * 创建共享 socket transport。
   *
   * Args:
   * - `kind`: WebSocket 或 Unix endpoint 的稳定 transport kind。
   * - `socket`: 已完成 upgrade 的 `ws` 连接。
   */
  constructor(
    readonly kind: Extract<ClientTransportKind, 'websocket' | 'unix'>,
    private readonly socket: WebSocket,
  ) {
    socket.on('message', (data) => {
      if (!this.incoming.push(toBytes(data))) socket.terminate();
    });
    socket.once('close', () => this.incoming.end());
    socket.once('error', (error) => this.incoming.fail(error));
  }

  /** 返回当前连接的完整消息流。 */
  messages(): AsyncIterable<Uint8Array> {
    return this.incoming;
  }

  /**
   * 等待底层发送回调，并在 `bufferedAmount` 超过高水位时暂停后续消息。
   *
   * Args:
   * - `message`: 单条完整 UTF-8 JSON-RPC 消息。
   */
  async send(message: Uint8Array): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.kind} transport is closed.`);
    }
    if (this.socket.bufferedAmount > SEND_HIGH_WATER_BYTES) {
      await this.waitForBufferedAmount(SEND_LOW_WATER_BYTES);
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(message, (error?: Error | null) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
    if (this.socket.bufferedAmount > SEND_HIGH_WATER_BYTES) {
      await this.waitForBufferedAmount(SEND_LOW_WATER_BYTES);
    }
  }

  /**
   * 关闭 socket；超时后 terminate，不能让 Client 生命周期无限等待 peer。
   *
   * Args:
   * - `reason`: 可观察的关闭原因。
   */
  async close(reason = 'client closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.incoming.end();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.socket.terminate();
        finish();
      }, CLOSE_TIMEOUT_MS);
      timer.unref();
      this.socket.once('close', finish);
      this.socket.close(1000, reason);
    });
  }

  private async waitForBufferedAmount(targetBytes: number): Promise<void> {
    while (this.socket.bufferedAmount > targetBytes) {
      if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error(
          `${this.kind} transport closed while waiting for backpressure.`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        timer.unref();
      });
    }
  }
}

/** TCP/TLS WebSocket Client transport。 */
export class WebSocketTransport extends SocketClientTransport {
  private constructor(socket: WebSocket) {
    super('websocket', socket);
  }

  /**
   * 建立远程 WebSocket transport。
   *
   * Args:
   * - `endpoint`: `ws://` 或 `wss://` endpoint。
   * - `token`: 可选 bearer token。
   *
   * Returns:
   * - Promise 在 WebSocket upgrade 完成后兑现为可用 transport。
   */
  static async connect(
    endpoint: string,
    token?: string,
  ): Promise<WebSocketTransport> {
    return new WebSocketTransport(
      await connectSocket(endpoint, authenticationOptions(token)),
    );
  }
}

/** Unix domain socket 上的 WebSocket Client transport。 */
export class UnixTransport extends SocketClientTransport {
  private constructor(socket: WebSocket) {
    super('unix', socket);
  }

  /**
   * 通过 Unix domain socket 建立 WebSocket transport。
   *
   * Args:
   * - `socketPath`: 已解析的绝对 socket 路径。
   * - `token`: 可选 bearer token。
   *
   * Returns:
   * - Promise 在 Unix socket 上的 WebSocket upgrade 完成后兑现。
   */
  static async connect(
    socketPath: string,
    token?: string,
  ): Promise<UnixTransport> {
    return new UnixTransport(
      await connectSocket('ws://localhost/', {
        ...authenticationOptions(token),
        createConnection: () => createConnection(socketPath),
      }),
    );
  }
}

function connectSocket(
  endpoint: string,
  options: ClientOptions,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, options);
    const onError = (error: Error) => reject(error);
    socket.once('error', onError);
    socket.once('open', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function authenticationOptions(token: string | undefined): ClientOptions {
  return token === undefined
    ? {}
    : { headers: { authorization: `Bearer ${token}` } };
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.from(data);
}
