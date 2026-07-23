import { ELLO_PROTOCOL_VERSION } from '@ello/agent/protocol';
import { describe, expect, it, vi } from 'vitest';


import {
  AppServerClient,
  ClientProtocolError,
  ResponseValidationError,
  ServerResponseError,
} from './app-server-client';
import { AsyncByteQueue, type AppTransport } from './transport';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 测试用 transport:入站可注入,出站被记录。 */
class MockTransport implements AppTransport {
  readonly kind = 'desktop-sidecar' as const;
  readonly inbound = new AsyncByteQueue();
  readonly sent: string[] = [];
  closed = false;
  sendFailure: Error | undefined;

  messages(): AsyncIterable<Uint8Array> {
    return this.inbound;
  }

  async send(message: Uint8Array): Promise<void> {
    if (this.sendFailure !== undefined) throw this.sendFailure;
    this.sent.push(decoder.decode(message));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.inbound.end();
  }

  emit(value: unknown): void {
    this.inbound.push(encoder.encode(JSON.stringify(value)));
  }

  lastSent(): Record<string, unknown> {
    const raw = this.sent[this.sent.length - 1];
    if (raw === undefined) throw new Error('No frame sent.');
    return JSON.parse(raw) as Record<string, unknown>;
  }
}

const INITIALIZE_PARAMS = {
  clientInfo: { name: 'ello-app', title: 'Ello', version: '0.1.0' },
  protocolVersion: ELLO_PROTOCOL_VERSION,
  capabilities: {
    experimentalApi: false,
    supportsServerRequests: true,
    supportsUserInput: true,
    optOutNotificationMethods: [],
    platform: 'desktop' as const,
  },
};

const INITIALIZE_RESULT = {
  protocolVersion: 1,
  serverInfo: { name: 'ello-agent', version: '1.0.0' },
  serverCapabilities: {
    transports: ['stdio'],
    methods: ['initialize'],
    notifications: [],
    serverRequests: [],
    granted: ['read', 'submit', 'approve', 'write', 'admin'],
  },
};

async function connectAndInitialize(): Promise<{
  client: AppServerClient;
  transport: MockTransport;
}> {
  const transport = new MockTransport();
  const client = new AppServerClient({ transport, requestTimeoutMs: 5_000 });
  await client.connect();
  const initializing = client.initialize(INITIALIZE_PARAMS);
  await vi.waitFor(() => {
    if (transport.sent.length === 0) throw new Error('waiting for initialize frame');
  });
  expect(transport.lastSent()['method']).toBe('initialize');
  transport.emit({ jsonrpc: '2.0', id: 1, result: INITIALIZE_RESULT });
  await initializing;
  return { client, transport };
}

describe('AppServerClient · 握手', () => {
  it('initialize -> initialized 后进入 ready', async () => {
    const { client, transport } = await connectAndInitialize();
    expect(client.state).toBe('ready');
    // 第二帧是 initialized notification。
    const frames = transport.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(frames[1]).toMatchObject({ method: 'initialized' });
  });

  it('ready 前发业务请求直接抛协议错误', async () => {
    const transport = new MockTransport();
    const client = new AppServerClient({ transport });
    await client.connect();
    await expect(client.request('workspace/list', {})).rejects.toThrow(
      ClientProtocolError,
    );
  });
});

describe('AppServerClient · 请求/响应', () => {
  it('响应按 id 关联并过 result schema', async () => {
    const { client, transport } = await connectAndInitialize();
    const pending = client.request('workspace/list', {});
    await vi.waitFor(() => {
      if (transport.sent.length < 3) throw new Error('waiting');
    });
    const request = transport.lastSent();
    transport.emit({
      jsonrpc: '2.0',
      id: request['id'],
      result: { data: [] },
    });
    await expect(pending).resolves.toEqual({ data: [] });
  });

  it('result 校验失败 → ResponseValidationError', async () => {
    const { client, transport } = await connectAndInitialize();
    const pending = client.request('workspace/list', {});
    await vi.waitFor(() => {
      if (transport.sent.length < 3) throw new Error('waiting');
    });
    transport.emit({
      jsonrpc: '2.0',
      id: transport.lastSent()['id'],
      result: { wrong: true },
    });
    await expect(pending).rejects.toThrow(ResponseValidationError);
    expect(client.state).toBe('closed');
    expect(transport.closed).toBe(true);
  });

  it('发送失败 → 连接关闭并拒绝请求', async () => {
    const { client, transport } = await connectAndInitialize();
    const failure = new Error('write failed');
    transport.sendFailure = failure;
    await expect(client.request('workspace/list', {})).rejects.toThrow('write failed');
    expect(client.state).toBe('closed');
    expect(transport.closed).toBe(true);
  });

  it('服务端 error 响应 → ServerResponseError 保留 rpc error', async () => {
    const { client, transport } = await connectAndInitialize();
    const pending = client.request('workspace/list', {});
    await vi.waitFor(() => {
      if (transport.sent.length < 3) throw new Error('waiting');
    });
    transport.emit({
      jsonrpc: '2.0',
      id: transport.lastSent()['id'],
      error: {
        code: -32004,
        message: 'thread not found',
        data: { type: 'threadNotFound', retryable: false },
      },
    });
    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ServerResponseError);
    expect((error as ServerResponseError).type).toBe('threadNotFound');
  });
});

describe('AsyncByteQueue', () => {
  it('同时限制消息数量与字节容量', async () => {
    const queue = new AsyncByteQueue(2, 3);
    expect(queue.push(new Uint8Array(2))).toBe(true);
    expect(queue.push(new Uint8Array(2))).toBe(false);
    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    expect(queue.push(new Uint8Array(2))).toBe(true);
    queue.end();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});

describe('AppServerClient · notification 与 server request', () => {
  it('notification 解析后分发', async () => {
    const { client, transport } = await connectAndInitialize();
    const received: string[] = [];
    client.onNotification((notification) => {
      received.push(notification.method);
    });
    transport.emit({
      jsonrpc: '2.0',
      method: 'skills/changed',
      params: { cwd: '/tmp', paths: [] },
    });
    await vi.waitFor(() => {
      if (received.length === 0) throw new Error('waiting');
    });
    expect(received).toEqual(['skills/changed']);
  });

  it('未知 notification method → 连接 fail', async () => {
    const { client, transport } = await connectAndInitialize();
    const closed = new Promise<Error | undefined>((resolve) =>
      client.onClose(resolve),
    );
    transport.emit({
      jsonrpc: '2.0',
      method: 'no/such/method',
      params: {},
    });
    const error = await closed;
    expect(error).toBeInstanceOf(ClientProtocolError);
    expect(client.state).toBe('closed');
  });

  it('server request 以原 srvreq_* ID 应答', async () => {
    const { client, transport } = await connectAndInitialize();
    const seen = new Promise<void>((resolve) => {
      client.onServerRequest((request) => {
        expect(request.id).toBe('srvreq_abc');
        expect(request.method).toBe('item/plan/requestApproval');
        void request.respond({ decision: 'accept' });
        resolve();
        return true;
      });
    });
    transport.emit({
      jsonrpc: '2.0',
      id: 'srvreq_abc',
      method: 'item/plan/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: 'r',
        availableDecisions: ['accept', 'decline', 'cancel'],
        contentHash: 'hash',
        preview: 'p',
      },
    });
    await seen;
    await vi.waitFor(() => {
      if (transport.sent.length < 3) throw new Error('waiting');
    });
    const response = transport.lastSent();
    expect(response['id']).toBe('srvreq_abc');
    expect(response['result']).toEqual({ decision: 'accept' });
  });

  it('非 srvreq_* 的 server request id → 协议违约', async () => {
    const { client, transport } = await connectAndInitialize();
    const closed = new Promise<Error | undefined>((resolve) =>
      client.onClose(resolve),
    );
    transport.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'item/plan/requestApproval',
      params: {},
    });
    const error = await closed;
    expect(error).toBeInstanceOf(ClientProtocolError);
  });
});
