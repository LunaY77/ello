/**
 * 本文件负责 App Server 的“stdio”模块职责。
 *
 * 连接、请求或传输状态只由本模块返回的对象持有；Server 不依赖产品 feature 的内部实现。
 * 响应、通知、背压和关闭顺序是协议不变量，异步失败必须传播到拥有该资源的生命周期边界。
 */
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import { createEntityId } from '../../ids.js';
import { AppServerError } from '../../protocol/errors.js';

import type { AppServerTransport } from './transport.js';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface StdioTransportOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly connectionId?: string;
  readonly maxMessageBytes?: number;
}

/** stdout 每行只写一条 JSON-RPC；日志必须由上层写 stderr。 */
export class StdioTransport implements AppServerTransport {
  readonly kind = 'stdio' as const;
  readonly connectionId: string;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly maxMessageBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * 创建 `StdioTransport`，由该实例独占 Server 门面的 `stdio` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `options`: 仅作用于 `constructor StdioTransport` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
   */
  constructor(options: StdioTransportOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.connectionId = options.connectionId ?? createEntityId('watch');
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  }

  /**
   * 执行 Server 门面的 `stdio` 模块 定义的 `messages` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回当前调用独占的异步事件流；迭代在发布终态后结束，生产失败会使迭代抛错。
   */
  async *messages(): AsyncIterable<Uint8Array> {
    let buffered = Buffer.alloc(0);
    for await (const chunk of this.input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered = Buffer.concat([buffered, bytes]);
      if (
        buffered.byteLength > this.maxMessageBytes &&
        !buffered.includes(10)
      ) {
        throw new AppServerError({
          type: 'invalidRequest',
          message: `stdio JSON-RPC line exceeds ${this.maxMessageBytes} bytes.`,
        });
      }
      let newline = buffered.indexOf(10);
      while (newline !== -1) {
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (line.byteLength > this.maxMessageBytes) {
          throw new AppServerError({
            type: 'invalidRequest',
            message: `stdio JSON-RPC line exceeds ${this.maxMessageBytes} bytes.`,
          });
        }
        if (line.byteLength > 0) yield line;
        newline = buffered.indexOf(10);
      }
    }
    if (buffered.byteLength > 0) {
      throw new AppServerError({
        type: 'parseError',
        message: 'stdio ended with an incomplete JSON-RPC line.',
      });
    }
  }

  /**
   * 处理 Server 门面的 `stdio` 模块 的 `send` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   *
   * Returns:
   * - Promise 在 Server 门面的 `stdio` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  send(message: Uint8Array): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('stdio transport is closed.'));
    }
    const operation = this.writeQueue.then(async () => {
      if (message.byteLength > this.maxMessageBytes) {
        throw new AppServerError({
          type: 'serverOverloaded',
          message: 'Outgoing JSON-RPC message exceeds the transport limit.',
        });
      }
      if (
        !this.output.write(
          Buffer.concat([Buffer.from(message), Buffer.from('\n')]),
        )
      ) {
        await once(this.output, 'drain');
      }
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /**
   * 停止 Server 门面的 `stdio` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 Server 门面的 `stdio` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeQueue;
    this.input.destroy();
    if (this.output !== process.stdout) this.output.end();
  }
}
