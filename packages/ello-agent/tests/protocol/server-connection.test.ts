/**
 * 本文件验证 server-connection 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  NotificationMessage,
  RequestMessage,
  ResponseMessage,
} from 'vscode-jsonrpc/node';

import {
  ProtocolMessageWriter,
  type RpcConnectionLimits,
} from '../../src/server/server-connection.js';
import type { AppServerTransport } from '../../src/server/transport/transport.js';

const decoder = new TextDecoder();

const TEST_LIMITS = {
  maxMessageBytes: 1_024,
  maxInboundMessages: 8,
  maxInboundBytes: 8_192,
  maxOutboundMessages: 8,
  maxOutboundBytes: 8_192,
  reservedResponseMessages: 2,
  reservedResponseBytes: 2_048,
  backpressureTimeoutMs: 10_000,
} as const satisfies RpcConnectionLimits;

describe('ProtocolMessageWriter outbound ordering', () => {
  it('先发送 RPC response，再释放 notification 和 Server Request', async () => {
    const transport = new TestTransport();
    const writer = new ProtocolMessageWriter(
      transport,
      TEST_LIMITS,
      () => undefined,
    );
    writer.beginResponseBarrier(1);
    const serverRequest: RequestMessage = {
      jsonrpc: '2.0',
      id: 'srvreq_test',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_test',
        turnId: 'turn_test',
        itemId: 'item_test',
        reason: 'test',
        command: ['pnpm', 'test'],
        cwd: '/workspace',
        availableDecisions: ['accept', 'decline'],
      },
    };
    const notification: NotificationMessage = {
      jsonrpc: '2.0',
      method: 'server/ready',
      params: { protocolVersion: 1 },
    };
    const response: ResponseMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    };
    await writer.write(serverRequest);
    await writer.write(notification);

    expect(transport.sent).toEqual([]);
    await writer.write(response);
    expect(
      transport.sent.map((message) =>
        'method' in message ? message.method : 'response',
      ),
    ).toEqual([
      'response',
      'item/commandExecution/requestApproval',
      'server/ready',
    ]);
  });

  it('outbox 满后等待背压超时再关闭连接，不静默扩展容量', async () => {
    const transport = new TestTransport();
    const limits = {
      ...TEST_LIMITS,
      maxOutboundMessages: 3,
      maxOutboundBytes: 2_048,
      reservedResponseMessages: 1,
      reservedResponseBytes: 1_024,
      backpressureTimeoutMs: 25,
    } satisfies RpcConnectionLimits;
    const writer = new ProtocolMessageWriter(transport, limits, (error) => {
      void transport.close(error.message, true);
    });
    const notification = (sequence: number): NotificationMessage => ({
      jsonrpc: '2.0',
      method: 'thread/sequence/advanced',
      params: { threadId: 'thr_test', seq: sequence },
    });
    writer.beginResponseBarrier(99);
    await writer.write(notification(1));
    await writer.write(notification(2));

    const blocked = writer.write(notification(3));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(transport.closeReasons).toEqual([]);
    await expect(blocked).rejects.toThrow(
      'outbound queue remained full for 25 ms',
    );
    await vi.waitFor(() => expect(transport.closeReasons).toHaveLength(1));
    expect(transport.closeReasons[0]).toContain(
      'outbound queue remained full for 25 ms',
    );
    expect(transport.closeForces).toEqual([true]);
  });
});

class TestTransport implements AppServerTransport {
  readonly kind = 'stdio' as const;
  readonly connectionId = 'watch_test';
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closeReasons: string[] = [];
  readonly closeForces: boolean[] = [];

  messages(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    };
  }

  send(message: Uint8Array): Promise<void> {
    this.sent.push(
      JSON.parse(decoder.decode(message)) as Record<string, unknown>,
    );
    return Promise.resolve();
  }

  /**
   * 停止 测试夹具的 `server-connection.test` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播；省略时使用声明中明确的调用语义。
   * - `force`: 显式控制 `close` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 测试夹具的 `server-connection.test` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(reason?: string, force?: boolean): Promise<void> {
    this.closeReasons.push(reason ?? 'closed');
    this.closeForces.push(force === true);
    return Promise.resolve();
  }
}
