import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import type {
  TurnExecutionHandle,
  TurnExecutor,
} from '../../src/domain/ports/turn-executor.js';
import type {
  ParsedClientParams,
  ThreadSnapshot,
} from '../../src/protocol/v1/index.js';
import type { RpcServices } from '../../src/server/methods/server-services.js';
import { ThreadManager } from '../../src/server/runtime/thread-manager.js';
import { AgentServer } from '../../src/server/server.js';
import {
  listenEndpoint,
  type ServerListener,
} from '../../src/server/transport/listeners.js';
import {
  createCodingStorage,
  type CodingStorage,
} from '../../src/storage/database/index.js';

describe('App Server network listeners', () => {
  let root: string;
  let storage: CodingStorage;
  let server: AgentServer;
  let listener: ServerListener | undefined;
  let client: WebSocket | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-listener-'));
    storage = createCodingStorage({
      databasePath: join(root, 'state.sqlite'),
      artifactsDir: join(root, 'artifacts'),
    });
    const threads = new ThreadManager({
      root,
      catalog: storage.threads,
      executorFactory: () => Promise.resolve(new IdleExecutor()),
      resolveInitialSettings: testInitialSettings,
      resolveSettingsUpdate: (_snapshot, params) => testSettingsUpdate(params),
    });
    server = new AgentServer({
      version: '1.0.0',
      threads,
      transports: ['websocket', 'unix'],
      services: new TestServices(),
    });
    await server.start();
  });

  afterEach(async () => {
    if (client !== undefined && client.readyState !== WebSocket.CLOSED) {
      client.terminate();
    }
    if (listener !== undefined) await listener.close();
    await server.stop('test complete');
    storage.close();
    await rm(root, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it('TCP listener 执行鉴权、Origin 拒绝、health 和 WebSocket framing', async () => {
    const port = await reserveTcpPort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const acceptTransport = vi.spyOn(server, 'acceptTransport');
    listener = await listenEndpoint({
      endpoint,
      authToken: 'secret',
      capabilities: ['read'],
      server,
    });

    await expect(
      readHealth({ hostname: '127.0.0.1', port, path: '/healthz' }),
    ).resolves.toEqual({ statusCode: 200, body: { status: 'ready' } });
    await expect(rejectedUpgradeStatus(endpoint)).resolves.toBe(401);
    await expect(
      rejectedUpgradeStatus(endpoint, {
        token: 'secret',
        origin: 'https://example.test',
      }),
    ).resolves.toBe(403);

    client = await connectWebSocket(endpoint, { token: 'secret' });
    const response = receiveJson(client);
    client.send(JSON.stringify(serverReadRequest()));
    await expect(response).resolves.toMatchObject({
      id: 1,
      error: { data: { type: 'notInitialized' } },
    });
    expect(acceptTransport).toHaveBeenCalledOnce();
    expect(acceptTransport.mock.calls[0]?.[0].kind).toBe('websocket');

    await listener.close();
    listener = undefined;
    await expect(waitForClose(client)).resolves.toBeUndefined();
  });

  it('Unix listener 使用 0600 socket、bearer auth 和 WebSocket framing', async () => {
    const socketPath = join(root, 'agent:test.sock');
    const endpoint = `unix://${socketPath}`;
    const acceptTransport = vi.spyOn(server, 'acceptTransport');
    listener = await listenEndpoint({
      endpoint,
      authToken: 'secret',
      capabilities: ['read'],
      server,
    });

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(readHealth({ socketPath, path: '/healthz' })).resolves.toEqual(
      {
        statusCode: 200,
        body: { status: 'ready' },
      },
    );
    await expect(
      rejectedUpgradeStatus('ws://localhost/', { socketPath }),
    ).resolves.toBe(401);

    client = await connectWebSocket('ws://localhost/', {
      token: 'secret',
      socketPath,
    });
    const response = receiveJson(client);
    client.send(JSON.stringify(serverReadRequest()));
    await expect(response).resolves.toMatchObject({
      id: 1,
      error: { data: { type: 'notInitialized' } },
    });
    expect(acceptTransport).toHaveBeenCalledOnce();
    expect(acceptTransport.mock.calls[0]?.[0].kind).toBe('unix');

    await listener.close();
    listener = undefined;
    await expect(waitForClose(client)).resolves.toBeUndefined();
  });
});

function serverReadRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'server/read',
    params: {},
  } as const;
}

function connectWebSocket(
  endpoint: string,
  options: WebSocketTestOptions = {},
): Promise<WebSocket> {
  const socketPath = options.socketPath;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      ...(options.token === undefined
        ? {}
        : { headers: { authorization: `Bearer ${options.token}` } }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(socketPath === undefined
        ? {}
        : { createConnection: () => createConnection(socketPath) }),
    });
    const onError = (error: Error) => reject(error);
    socket.once('error', onError);
    socket.once('open', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function rejectedUpgradeStatus(
  endpoint: string,
  options: WebSocketTestOptions = {},
): Promise<number> {
  const socketPath = options.socketPath;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      ...(options.token === undefined
        ? {}
        : { headers: { authorization: `Bearer ${options.token}` } }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(socketPath === undefined
        ? {}
        : { createConnection: () => createConnection(socketPath) }),
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', reject);
    socket.once('open', () => {
      socket.close();
      reject(new Error(`Expected WebSocket upgrade for ${endpoint} to fail.`));
    });
  });
}

interface WebSocketTestOptions {
  readonly token?: string;
  readonly origin?: string;
  readonly socketPath?: string;
}

function receiveJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('message', (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      resolve(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>);
    });
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('close', () => resolve());
    socket.once('error', reject);
  });
}

function readHealth(options: RequestOptions): Promise<{
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >,
        });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

async function reserveTcpPort(): Promise<number> {
  const socket = createNetServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
  const address = socket.address();
  if (address === null || typeof address === 'string') {
    throw new Error('TCP listener did not expose a numeric port.');
  }
  await new Promise<void>((resolve, reject) => {
    socket.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return address.port;
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

function testSettingsUpdate(
  params: Omit<ParsedClientParams<'thread/settings/update'>, 'threadId'>,
): Promise<Partial<ThreadSnapshot['settings']>> {
  return Promise.resolve({
    ...(params.mode === undefined ? {} : { mode: params.mode }),
    ...(params.profile === undefined ? {} : { profile: params.profile }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.agent === undefined ? {} : { agent: params.agent }),
  });
}

class TestServices implements RpcServices {
  dispatch(): Promise<unknown> {
    return Promise.reject(new Error('Unexpected non-core RPC method.'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
