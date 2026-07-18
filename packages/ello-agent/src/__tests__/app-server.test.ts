import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigValidationError } from '../config/index.js';
import type {
  TurnExecutionHandle,
  TurnExecutor,
} from '../domain/ports/turn-executor.js';
import {
  ELLO_PROTOCOL_VERSION,
  type ParsedClientParams,
} from '../protocol/v1/index.js';
import type { RpcServices } from '../server/methods/server-services.js';
import { ThreadManager } from '../server/runtime/thread-manager.js';
import { AgentServer } from '../server/server.js';
import type { AppServerTransport } from '../server/transport/transport.js';
import {
  createCodingStorage,
  type CodingStorage,
} from '../storage/database/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('AgentServer JSON-RPC processor', () => {
  let root: string;
  let storage: CodingStorage;
  let threads: ThreadManager;
  let server: AgentServer;
  let services: TestServices;
  let transport: TestTransport;
  let connectionTask: Promise<void>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-app-server-'));
    storage = createCodingStorage({
      databasePath: join(root, 'state.sqlite'),
      artifactsDir: join(root, 'artifacts'),
    });
    threads = new ThreadManager({
      root,
      catalog: storage.threads,
      executorFactory: () => Promise.resolve(new IdleExecutor()),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => Promise.resolve(params),
    });
    services = new TestServices();
    server = new AgentServer({
      version: '1.0.0',
      threads,
      transports: ['stdio'],
      services,
    });
    transport = new TestTransport();
    await server.start();
    connectionTask = server.acceptTransport(transport, [
      'read',
      'submit',
      'approve',
      'write',
      'admin',
    ]);
  });

  afterEach(async () => {
    await server.stop('test complete');
    await connectionTask;
    storage.close();
    await rm(root, { force: true, recursive: true });
  });

  it('严格执行 initialize -> initialized 握手', async () => {
    await transport.clientSend(request(1, 'server/read', {}));
    expect(await transport.clientReceive()).toMatchObject({
      id: 1,
      error: { data: { type: 'notInitialized' } },
    });

    await initialize(transport);
    await transport.clientSend(request(2, 'server/read', {}));
    expect(await transport.clientReceive()).toMatchObject({
      id: 2,
      result: {
        protocolVersion: ELLO_PROTOCOL_VERSION,
        version: '1.0.0',
        state: 'ready',
      },
    });
  });

  it('重复 initialize 和未知 method 返回稳定错误类型', async () => {
    await initialize(transport);
    await transport.clientSend(request(2, 'initialize', initializeParams()));
    expect(await transport.clientReceive()).toMatchObject({
      id: 2,
      error: { data: { type: 'alreadyInitialized' } },
    });
    await transport.clientSend(request(3, 'unknown/method', {}));
    expect(await transport.clientReceive()).toMatchObject({
      id: 3,
      error: { code: -32601, data: { type: 'methodNotFound' } },
    });
  });

  it('strict params 拒绝 unknown field', async () => {
    await initialize(transport);
    await transport.clientSend(request(2, 'thread/list', { unexpected: true }));
    expect(await transport.clientReceive()).toMatchObject({
      id: 2,
      error: { code: -32602, data: { type: 'invalidParams' } },
    });
  });

  it('handler 返回值违反响应 schema 时返回独立错误类型', async () => {
    await initialize(transport);
    services.resolve({ invalid: true });
    await transport.clientSend(
      request(2, 'config/read', { cwd: '/workspace', includeSources: true }),
    );

    expect(await transport.clientReceive()).toMatchObject({
      id: 2,
      error: {
        code: -32013,
        data: {
          type: 'responseValidationFailed',
          details: { method: 'config/read' },
        },
      },
    });
  });

  it('配置校验失败时返回 configInvalid 和具体 issues', async () => {
    await initialize(transport);
    services.reject(
      new ConfigValidationError('Invalid test config.', [
        { path: ['tools', 'need_approval'], message: 'Expected array.' },
      ]),
    );
    await transport.clientSend(
      request(2, 'config/read', { cwd: '/workspace', includeSources: true }),
    );

    expect(await transport.clientReceive()).toMatchObject({
      id: 2,
      error: {
        code: -32012,
        message: 'Invalid test config.',
        data: {
          type: 'configInvalid',
          details: {
            issues: [
              {
                path: ['tools', 'need_approval'],
                message: 'Expected array.',
              },
            ],
          },
        },
      },
    });
  });

  it('thread/start、read、list 使用同一持久化主源', async () => {
    await initialize(transport);
    await transport.clientSend(
      request(2, 'thread/start', { cwd: '/workspace', subscribe: true }),
    );
    const started = await transport.clientReceive();
    const threadId = readThreadId(started);
    await transport.clientSend(
      request(3, 'thread/read', {
        threadId,
        includeTurns: true,
        includeItems: true,
      }),
    );
    expect(await transport.clientReceive()).toMatchObject({
      id: 3,
      result: { thread: { id: threadId, cwd: '/workspace' } },
    });
    await transport.clientSend(
      request(4, 'thread/list', { archived: false, limit: 50 }),
    );
    expect(await transport.clientReceive()).toMatchObject({
      id: 4,
      result: { data: [{ id: threadId }] },
    });
  });

  it('thread/settings/update 可持久化 settings-only metadata', async () => {
    await initialize(transport);
    await transport.clientSend(
      request(2, 'thread/start', { cwd: '/workspace', subscribe: true }),
    );
    const threadId = readThreadId(await transport.clientReceive());

    await transport.clientSend(
      request(3, 'thread/settings/update', {
        threadId,
        profile: 'deepseek',
      }),
    );

    expect(await transport.clientReceive()).toMatchObject({
      id: 3,
      result: { profile: 'deepseek' },
    });
    expect(storage.threads.state(threadId)?.seq).toBe(2);
  });

  it('协议版本不匹配返回 protocolMismatch 并关闭连接', async () => {
    await transport.clientSend(
      request(1, 'initialize', {
        ...initializeParams(),
        protocolVersion: 99,
      }),
    );
    expect(await transport.clientReceive()).toMatchObject({
      id: 1,
      error: { data: { type: 'protocolMismatch' } },
    });
    await connectionTask;
    expect(transport.closed).toBe(true);
  });

  it('parse error 使用 null id，连接仍可重新发送合法消息', async () => {
    await transport.clientSendRaw('{bad json');
    expect(await transport.clientReceive()).toMatchObject({
      id: null,
      error: { code: -32700, data: { type: 'parseError' } },
    });
    await initialize(transport);
  });
});

async function initialize(transport: TestTransport): Promise<void> {
  await transport.clientSend(request(1, 'initialize', initializeParams()));
  expect(await transport.clientReceive()).toMatchObject({
    id: 1,
    result: {
      protocolVersion: ELLO_PROTOCOL_VERSION,
      serverInfo: { name: 'ello-agent' },
    },
  });
  await transport.clientSend({
    jsonrpc: '2.0',
    method: 'initialized',
    params: {},
  });
  expect(await transport.clientReceive()).toMatchObject({
    method: 'server/ready',
    params: { protocolVersion: ELLO_PROTOCOL_VERSION },
  });
}

function initializeParams() {
  return {
    clientInfo: { name: 'test', title: 'Test', version: '1.0.0' },
    protocolVersion: ELLO_PROTOCOL_VERSION,
    capabilities: {
      experimentalApi: false,
      supportsServerRequests: true,
      supportsUserInput: true,
      optOutNotificationMethods: [],
      platform: 'automation',
    },
  } as const;
}

function request(
  id: string | number,
  method: string,
  params: Readonly<Record<string, unknown>>,
) {
  return { jsonrpc: '2.0', id, method, params } as const;
}

function readThreadId(message: Readonly<Record<string, unknown>>): string {
  const result = message.result as {
    readonly thread?: { readonly id?: unknown };
  };
  if (typeof result.thread?.id !== 'string')
    throw new Error('Missing thread id.');
  return result.thread.id;
}

class IdleExecutor implements TurnExecutor {
  start(): Promise<TurnExecutionHandle> {
    return Promise.reject(new Error('IdleExecutor does not run turns.'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function testInitialSettings(params: ParsedClientParams<'thread/start'>) {
  return Promise.resolve({
    mode: params.mode ?? 'ask-before-changes',
    profile: params.profile ?? 'test',
    model: params.model ?? 'test:model',
    agent: params.agent ?? 'build',
  } as const);
}

class TestServices implements RpcServices {
  private outcome:
    | { readonly type: 'resolve'; readonly value: unknown }
    | { readonly type: 'reject'; readonly error: unknown }
    | undefined;

  resolve(value: unknown): void {
    this.outcome = { type: 'resolve', value };
  }

  reject(error: unknown): void {
    this.outcome = { type: 'reject', error };
  }

  dispatch(): Promise<unknown> {
    if (this.outcome?.type === 'resolve') {
      return Promise.resolve(this.outcome.value);
    }
    if (this.outcome?.type === 'reject') {
      return Promise.reject(this.outcome.error);
    }
    return Promise.reject(new Error('Unexpected non-core RPC method.'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class TestTransport implements AppServerTransport {
  readonly kind = 'stdio' as const;
  readonly connectionId = 'connection_test';
  readonly incoming = new MessageQueue();
  readonly outgoing = new MessageQueue();
  closed = false;

  messages(): AsyncIterable<Uint8Array> {
    return this.incoming;
  }

  send(message: Uint8Array): Promise<void> {
    this.outgoing.push(message.slice());
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.incoming.end();
    this.outgoing.end();
    return Promise.resolve();
  }

  clientSend(message: Readonly<Record<string, unknown>>): Promise<void> {
    return this.clientSendRaw(JSON.stringify(message));
  }

  clientSendRaw(message: string): Promise<void> {
    this.incoming.push(encoder.encode(message));
    return Promise.resolve();
  }

  async clientReceive(): Promise<Record<string, unknown>> {
    const next = await this.outgoing.next();
    if (next.done) throw new Error('Transport closed before response.');
    return JSON.parse(decoder.decode(next.value)) as Record<string, unknown>;
  }
}

class MessageQueue implements AsyncIterable<Uint8Array> {
  private readonly values: Uint8Array[] = [];
  private readonly waiters: Array<(value: IteratorResult<Uint8Array>) => void> =
    [];
  private ended = false;

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next: () => this.next() };
  }

  push(value: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ done: false, value });
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
