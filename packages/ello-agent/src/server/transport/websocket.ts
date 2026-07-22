/**
 * WebSocket 与 Unix socket 的共享 framing、有限 inbound queue 和关闭生命周期。
 *
 * 每个 WebSocket frame 是一条完整 RPC 消息；队列超过上限立即失败，优雅关闭超时后强制 terminate。
 * Unix endpoint 只改变 transport kind，不能复制另一套消息协议或队列。
 */
import type WebSocket from 'ws';

import { createEntityId } from '../../ids.js';

import type { AppServerTransport } from './transport.js';

const DEFAULT_MAX_INBOUND_MESSAGES = 256;
const DEFAULT_MAX_INBOUND_BYTES = 16 * 1024 * 1024;
const DEFAULT_SEND_HIGH_WATER_BYTES = 1024 * 1024;
const DEFAULT_SEND_LOW_WATER_BYTES = 512 * 1024;

export interface WebSocketTransportOptions {
  readonly connectionId?: string;
  readonly closeTimeoutMs?: number;
  readonly maxInboundMessages?: number;
  readonly maxInboundBytes?: number;
  readonly sendHighWaterBytes?: number;
  readonly sendLowWaterBytes?: number;
}

/** WebSocket 只负责把一帧转换成完整消息，RPC 解析仍由 MessageConnection 完成。 */
export class WebSocketTransport implements AppServerTransport {
  readonly kind = 'websocket' as const;
  readonly connectionId: string;
  private readonly incoming: AsyncByteQueue;
  private readonly closeTimeoutMs: number;
  private readonly sendHighWaterBytes: number;
  private readonly sendLowWaterBytes: number;
  private closed = false;

  /**
   * 创建 `WebSocketTransport`，由该实例独占 Server 门面的 `websocket` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `socket`: `constructor WebSocketTransport` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `options`: 仅作用于 `constructor WebSocketTransport` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
   */
  constructor(
    private readonly socket: WebSocket,
    options: WebSocketTransportOptions = {},
  ) {
    this.connectionId = options.connectionId ?? createEntityId('watch');
    this.closeTimeoutMs = options.closeTimeoutMs ?? 1_000;
    this.sendHighWaterBytes =
      options.sendHighWaterBytes ?? DEFAULT_SEND_HIGH_WATER_BYTES;
    this.sendLowWaterBytes =
      options.sendLowWaterBytes ?? DEFAULT_SEND_LOW_WATER_BYTES;
    assertWaterMarks(this.sendHighWaterBytes, this.sendLowWaterBytes);
    this.incoming = new AsyncByteQueue(
      options.maxInboundMessages ?? DEFAULT_MAX_INBOUND_MESSAGES,
      options.maxInboundBytes ?? DEFAULT_MAX_INBOUND_BYTES,
    );
    socket.on('message', (data) => {
      if (!this.incoming.push(toBytes(data))) socket.terminate();
    });
    socket.once('close', () => this.incoming.end());
    socket.once('error', (error) => this.incoming.fail(error));
  }

  /**
   * 执行 Server 门面的 `websocket` 模块 定义的 `messages` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回当前调用独占的异步事件流；迭代在发布终态后结束，生产失败会使迭代抛错。
   */
  messages(): AsyncIterable<Uint8Array> {
    return this.incoming;
  }

  /**
   * 处理 Server 门面的 `websocket` 模块 的 `send` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   *
   * Returns:
   * - Promise 在 Server 门面的 `websocket` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async send(message: Uint8Array): Promise<void> {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('WebSocket transport is closed.');
    }
    if (this.socket.bufferedAmount > this.sendHighWaterBytes) {
      await this.waitForBufferedAmount(this.sendLowWaterBytes);
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(message, (error?: Error | null) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
    if (this.socket.bufferedAmount > this.sendHighWaterBytes) {
      await this.waitForBufferedAmount(this.sendLowWaterBytes);
    }
  }

  /**
   * 停止 Server 门面的 `websocket` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
   * - `force`: 显式控制 `close` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 Server 门面的 `websocket` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async close(reason = 'server closed', force = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.incoming.end();
    if (this.socket.readyState === this.socket.CLOSED) return;
    if (force) {
      this.socket.terminate();
      return;
    }
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
      }, this.closeTimeoutMs);
      timer.unref();
      this.socket.once('close', finish);
      this.socket.close(1000, reason);
    });
  }

  private async waitForBufferedAmount(targetBytes: number): Promise<void> {
    while (this.socket.bufferedAmount > targetBytes) {
      if (this.closed || this.socket.readyState !== this.socket.OPEN) {
        throw new Error('WebSocket closed while waiting for backpressure.');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        timer.unref();
      });
    }
  }
}

/** Unix endpoint 使用与 WebSocket 完全相同的 frame 和关闭语义。 */
export class UnixSocketTransport implements AppServerTransport {
  readonly kind = 'unix' as const;
  readonly connectionId: string;
  private readonly delegate: WebSocketTransport;

  /**
   * 创建 `UnixSocketTransport`，由该实例独占 Server 门面的 `websocket` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `socket`: `constructor UnixSocketTransport` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `connectionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   */
  constructor(socket: WebSocket, connectionId?: string) {
    this.delegate = new WebSocketTransport(
      socket,
      connectionId === undefined ? {} : { connectionId },
    );
    this.connectionId = this.delegate.connectionId;
  }

  /**
   * 执行 Server 门面的 `websocket` 模块 定义的 `messages` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回当前调用独占的异步事件流；迭代在发布终态后结束，生产失败会使迭代抛错。
   */
  messages(): AsyncIterable<Uint8Array> {
    return this.delegate.messages();
  }

  /**
   * 处理 Server 门面的 `websocket` 模块 的 `send` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   *
   * Returns:
   * - Promise 在 Server 门面的 `websocket` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  send(message: Uint8Array): Promise<void> {
    return this.delegate.send(message);
  }

  /**
   * 停止 Server 门面的 `websocket` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
   * - `force`: 显式控制 `close` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 Server 门面的 `websocket` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(reason?: string, force?: boolean): Promise<void> {
    return this.delegate.close(reason, force);
  }
}

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  private readonly values: Uint8Array[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<Uint8Array>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;
  private queuedBytes = 0;

  constructor(
    private readonly maxLength: number,
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
      throw new Error('WebSocket inbound message limit must be positive.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('WebSocket inbound byte limit must be positive.');
    }
  }

  push(value: Uint8Array): boolean {
    if (this.ended) return false;
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      if (
        this.values.length >= this.maxLength ||
        this.queuedBytes + value.byteLength > this.maxBytes
      ) {
        this.fail(
          new Error(
            `Transport inbound queue exceeds ${this.maxLength} messages or ${this.maxBytes} bytes.`,
          ),
        );
        return false;
      }
      const copy = value.slice();
      this.values.push(copy);
      this.queuedBytes += copy.byteLength;
    } else {
      waiter.resolve({ done: false, value: value.slice() });
    }
    return true;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.queuedBytes -= value.byteLength;
          return Promise.resolve({ done: false, value });
        }
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) =>
          this.waiters.push({ resolve, reject }),
        );
      },
    };
  }
}

function assertWaterMarks(highBytes: number, lowBytes: number): void {
  if (
    !Number.isSafeInteger(highBytes) ||
    highBytes <= 0 ||
    !Number.isSafeInteger(lowBytes) ||
    lowBytes <= 0 ||
    lowBytes > highBytes
  ) {
    throw new Error(
      'WebSocket send water marks must be positive and low must not exceed high.',
    );
  }
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.from(data);
}
