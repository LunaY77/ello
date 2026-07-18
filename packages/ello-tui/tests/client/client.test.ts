import {
  APP_SERVER_ERROR_CODES,
  ELLO_PROTOCOL_VERSION,
  type InitializeParamsSchema,
  type RpcRequest,
} from '@ello/agent/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { AppServerClient } from '../../src/api/client.js';
import {
  RequestTimeoutError,
  ResponseValidationError,
  ServerResponseError,
} from '../../src/api/request-errors.js';
import { createMemoryTransportPair } from '../../src/testing/memory-transport.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const initializeParams: z.input<typeof InitializeParamsSchema> = {
  clientInfo: { name: 'test', title: 'Test Client', version: '1.0.0' },
  protocolVersion: ELLO_PROTOCOL_VERSION,
  capabilities: {
    experimentalApi: false,
    supportsServerRequests: true,
    supportsUserInput: true,
    optOutNotificationMethods: [],
    platform: 'automation',
  },
};

const initializeResult = {
  protocolVersion: ELLO_PROTOCOL_VERSION,
  serverInfo: { name: 'ello-agent' as const, version: '1.0.0' },
  serverCapabilities: {
    transports: ['stdio' as const],
    methods: ['server/read'],
    notifications: [],
    serverRequests: ['item/commandExecution/requestApproval'],
    granted: ['read' as const, 'approve' as const],
  },
};

const serverReadResult = {
  protocolVersion: ELLO_PROTOCOL_VERSION,
  version: '1.0.0',
  state: 'ready' as const,
  uptimeMs: 1,
  capabilities: ['read' as const],
};

afterEach(() => vi.useRealTimers());

describe('AppServerClient', () => {
  it('完成 initialize 握手后才能发送业务请求', async () => {
    const pair = createMemoryTransportPair();
    const client = new AppServerClient({ transport: pair.client });
    const serverMessages = pair.server.messages()[Symbol.asyncIterator]();
    const serverTask = (async () => {
      const initialize = await readRequest(serverMessages);
      expect(initialize.method).toBe('initialize');
      await send(pair.server, {
        jsonrpc: '2.0',
        id: initialize.id,
        result: initializeResult,
      });
      const initialized = await readJson(serverMessages);
      expect(initialized).toEqual({
        jsonrpc: '2.0',
        method: 'initialized',
        params: {},
      });
      const read = await readRequest(serverMessages);
      await send(pair.server, {
        jsonrpc: '2.0',
        id: read.id,
        result: serverReadResult,
      });
    })();

    await client.connect();
    await expect(client.request('server/read', {})).rejects.toThrow(
      'while client is connected',
    );
    await expect(client.initialize(initializeParams)).resolves.toEqual(
      initializeResult,
    );
    await expect(client.request('server/read', {})).resolves.toEqual(
      serverReadResult,
    );
    await serverTask;
    await client.close();
  });

  it('按 request id 关联乱序响应', async () => {
    const context = await initializedClient();
    const serverMessages = context.server.messages()[Symbol.asyncIterator]();
    const first = context.client.request('server/read', {});
    const second = context.client.request('thread/list', {
      archived: false,
      limit: 10,
    });
    const firstRequest = await readRequest(serverMessages);
    const secondRequest = await readRequest(serverMessages);
    await send(context.server, {
      jsonrpc: '2.0',
      id: secondRequest.id,
      result: { data: [] },
    });
    await send(context.server, {
      jsonrpc: '2.0',
      id: firstRequest.id,
      result: serverReadResult,
    });

    await expect(first).resolves.toEqual(serverReadResult);
    await expect(second).resolves.toEqual({ data: [] });
    await context.client.close();
  });

  it('区分 Server 错误与响应 schema 错误', async () => {
    const context = await initializedClient();
    const serverMessages = context.server.messages()[Symbol.asyncIterator]();

    const rejected = context.client.request('server/read', {});
    const rejectedRequest = await readRequest(serverMessages);
    await send(context.server, {
      jsonrpc: '2.0',
      id: rejectedRequest.id,
      error: {
        code: APP_SERVER_ERROR_CODES.permissionDenied,
        message: 'denied',
        data: {
          type: 'permissionDenied',
          retryable: false,
        },
      },
    });
    await expect(rejected).rejects.toBeInstanceOf(ServerResponseError);

    const invalid = context.client.request('server/read', {});
    const invalidRequest = await readRequest(serverMessages);
    await send(context.server, {
      jsonrpc: '2.0',
      id: invalidRequest.id,
      result: { state: 'ready' },
    });
    await expect(invalid).rejects.toBeInstanceOf(ResponseValidationError);
    await context.client.close();
  });

  it('请求超时后清理 pending 关联', async () => {
    vi.useFakeTimers();
    const context = await initializedClient({ requestTimeoutMs: 25 });
    const request = context.client.request('server/read', {});
    const assertion =
      expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    await context.client.close();
  });

  it('把 Server Request 交给显式 handler 并回写 response', async () => {
    const context = await initializedClient();
    const serverMessages = context.server.messages()[Symbol.asyncIterator]();
    context.client.onServerRequest(async (request) => {
      expect(request.method).toBe('item/commandExecution/requestApproval');
      await request.respond({ decision: 'acceptForSession' });
    });
    await send(context.server, {
      jsonrpc: '2.0',
      id: 'srvreq_1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        reason: 'write',
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        command: ['pnpm', 'test'],
        cwd: '/workspace',
      },
    });
    await expect(readJson(serverMessages)).resolves.toEqual({
      jsonrpc: '2.0',
      id: 'srvreq_1',
      result: { decision: 'acceptForSession' },
    });
    await context.client.close();
  });
});

async function initializedClient(options?: {
  readonly requestTimeoutMs: number;
}) {
  const pair = createMemoryTransportPair();
  const client = new AppServerClient({
    transport: pair.client,
    ...(options === undefined ? {} : options),
  });
  const messages = pair.server.messages()[Symbol.asyncIterator]();
  await client.connect();
  const initialization = client.initialize(initializeParams);
  const request = await readRequest(messages);
  await send(pair.server, {
    jsonrpc: '2.0',
    id: request.id,
    result: initializeResult,
  });
  await readJson(messages);
  await initialization;
  return { client, server: pair.server };
}

async function readJson(
  iterator: AsyncIterator<Uint8Array>,
): Promise<Record<string, unknown>> {
  const next = await iterator.next();
  if (next.done) throw new Error('Transport ended before the next message.');
  return JSON.parse(decoder.decode(next.value)) as Record<string, unknown>;
}

async function readRequest(
  iterator: AsyncIterator<Uint8Array>,
): Promise<RpcRequest> {
  return (await readJson(iterator)) as RpcRequest;
}

function send(
  transport: { send(message: Uint8Array): Promise<void> },
  message: Readonly<Record<string, unknown>>,
): Promise<void> {
  return transport.send(encoder.encode(JSON.stringify(message)));
}
