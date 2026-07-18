import { describe, expect, it, vi } from 'vitest';

import { ServerConnection } from '../../src/server/connection/server-connection.js';
import type { AppServerTransport } from '../../src/server/transport/transport.js';

const decoder = new TextDecoder();

describe('ServerConnection outbound ordering', () => {
  it('先发送 RPC response，再释放 notification 和 Server Request', async () => {
    const transport = new TestTransport();
    const connection = new ServerConnection(transport, [
      'read',
      'submit',
      'approve',
    ]);
    const release = connection.holdUnsolicited();
    const request = connection.request(
      'srvreq_test',
      'item/commandExecution/requestApproval',
      {
        threadId: 'thr_test',
        turnId: 'turn_test',
        itemId: 'item_test',
        reason: 'test',
        command: ['pnpm', 'test'],
        cwd: '/workspace',
        availableDecisions: ['accept', 'decline'],
      },
    );
    void request.catch(() => undefined);
    await connection.sendNotification({
      method: 'server/ready',
      params: { protocolVersion: 1 },
    });

    await connection.sendResult(1, { ok: true });
    expect(transport.sent).toEqual([
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
    ]);

    await release();
    expect(
      transport.sent.map((message) =>
        'method' in message ? message.method : 'response',
      ),
    ).toEqual([
      'response',
      'item/commandExecution/requestApproval',
      'server/ready',
    ]);
    await connection.close('test complete');
  });

  it('慢连接超过有界队列后主动关闭，不静默丢弃终态消息', async () => {
    const transport = new TestTransport({ blockSends: true });
    const connection = new ServerConnection(transport, ['read'], {
      maxQueuedSends: 2,
    });
    void connection.sendResult(1, { value: 1 }).catch(() => undefined);
    void connection.sendResult(2, { value: 2 }).catch(() => undefined);

    await expect(connection.sendResult(3, { value: 3 })).rejects.toThrow(
      'outbound queue exceeds 2 messages',
    );
    await vi.waitFor(() => expect(transport.closeReasons).toHaveLength(1));
    expect(transport.closeReasons[0]).toContain('outbound queue exceeds 2');
  });
});

class TestTransport implements AppServerTransport {
  readonly kind = 'stdio' as const;
  readonly connectionId = 'watch_test';
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closeReasons: string[] = [];

  constructor(
    private readonly options: { readonly blockSends?: boolean } = {},
  ) {}

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
    return this.options.blockSends === true
      ? new Promise(() => undefined)
      : Promise.resolve();
  }

  close(reason?: string): Promise<void> {
    this.closeReasons.push(reason ?? 'closed');
    return Promise.resolve();
  }
}
