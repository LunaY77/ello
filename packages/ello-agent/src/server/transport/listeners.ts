/**
 * 本文件负责 Fastify HTTP/WebSocket 宿主、鉴权、健康检查和 listener 生命周期。
 *
 * Fastify 只处理 upgrade 前的 HTTP 边界；连接建立后立即交给 `ServerConnection`，RPC method、Zod
 * 校验、顺序屏障和背压不进入 Fastify response pipeline。
 */
import { chmod, unlink } from 'node:fs/promises';

import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import type { Capability } from '../../protocol/v1/index.js';
import { AgentServer } from '../server.js';

import { UnixSocketTransport, WebSocketTransport } from './websocket.js';

const MAX_WEBSOCKET_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_CONNECTIONS = 64;

export interface ListenerOptions {
  readonly endpoint: string;
  readonly authToken?: string;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly server: AgentServer;
}

export interface ServerListener {
  /**
   * 停止接受 upgrade，关闭全部 WebSocket 并等待对应 AgentServer connection 释放。
   *
   * Args:
   * - 无：使用 listener 已经拥有的 Fastify 实例和连接任务。
   *
   * Returns:
   * - Promise 在网络句柄、连接任务和 Unix socket 文件全部释放后兑现。
   */
  close(): Promise<void>;
}

interface ListenerAddress {
  readonly kind: 'websocket' | 'unix';
  readonly routePath: string;
  readonly host?: string;
  readonly port?: number;
  readonly socketPath?: string;
}

/**
 * 根据 ws:// 或 unix:// endpoint 创建唯一 Fastify listener。
 *
 * Args:
 * - `options`: endpoint、鉴权 token、连接 capability 和目标 AgentServer。
 *
 * Returns:
 * - Promise 在 Fastify 已开始监听后兑现为可关闭的 listener。
 */
export async function listenEndpoint(
  options: ListenerOptions,
): Promise<ServerListener> {
  const address = parseListenerAddress(options.endpoint);
  const app = Fastify({ logger: false });
  const connections = new Set<Promise<void>>();
  await registerWebSocketHost(app, address, options, connections);
  if (address.kind === 'websocket') {
    await app.listen({
      host: requireWebSocketHost(address),
      port: requireWebSocketPort(address),
    });
  } else {
    await app.listen({ path: requireSocketPath(address) });
    await chmod(requireSocketPath(address), 0o600);
  }
  return {
    close: () => closeListener(app, address, connections),
  };
}

function requireWebSocketHost(address: ListenerAddress): string {
  if (address.kind !== 'websocket' || address.host === undefined) {
    throw new Error('WebSocket listener requires a host.');
  }
  return address.host;
}

function requireWebSocketPort(address: ListenerAddress): number {
  if (address.kind !== 'websocket' || address.port === undefined) {
    throw new Error('WebSocket listener requires a port.');
  }
  return address.port;
}

async function registerWebSocketHost(
  app: FastifyInstance,
  address: ListenerAddress,
  options: ListenerOptions,
  connections: Set<Promise<void>>,
): Promise<void> {
  await app.register(websocket, {
    options: { maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES },
    errorHandler(error, socket) {
      socket.terminate();
      options.server.logConnectionFailure('websocket.handler.failed', error);
    },
  });
  app.get('/healthz', async (_request, reply) => health(options.server, reply));
  app.get('/readyz', async (_request, reply) => health(options.server, reply));
  app.get(
    address.routePath,
    {
      websocket: true,
      preValidation: async (request, reply) =>
        authorizeUpgrade(request, reply, address, options, connections.size),
    },
    (socket) => {
      const transport =
        address.kind === 'unix'
          ? new UnixSocketTransport(socket)
          : new WebSocketTransport(socket);
      const task = options.server
        .acceptTransport(transport, options.capabilities)
        .finally(() => connections.delete(task));
      connections.add(task);
    },
  );
}

function health(server: AgentServer, reply: FastifyReply) {
  const ready = server.state === 'ready';
  void reply.code(ready ? 200 : 503);
  return { status: ready ? 'ready' : server.state };
}

async function authorizeUpgrade(
  request: FastifyRequest,
  reply: FastifyReply,
  address: ListenerAddress,
  options: ListenerOptions,
  connectionCount: number,
): Promise<void> {
  if (connectionCount >= MAX_CONNECTIONS) {
    await reply.code(503).send({ error: 'connection limit exceeded' });
    return;
  }
  if (address.kind === 'websocket' && request.headers.origin !== undefined) {
    await reply.code(403).send({ error: 'origin is not allowed' });
    return;
  }
  const authToken = options.authToken;
  if (authToken !== undefined) {
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
    return;
  }
  if (address.kind === 'websocket' && !isLoopbackRemote(request.ip)) {
    await reply.code(403).send({ error: 'remote client is not allowed' });
  }
}

function parseListenerAddress(endpoint: string): ListenerAddress {
  if (endpoint.startsWith('unix://')) {
    const socketPath = decodeURIComponent(endpoint.slice('unix://'.length));
    if (socketPath === '') {
      throw new Error('unix:// endpoint requires a socket path.');
    }
    return { kind: 'unix', routePath: '/', socketPath };
  }
  const url = new URL(endpoint);
  if (url.protocol === 'wss:') {
    throw new Error(
      'wss:// server endpoints require TLS configuration and are not enabled.',
    );
  }
  if (url.protocol !== 'ws:') {
    throw new Error(`Unsupported listen endpoint: ${endpoint}`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error('ws:// listeners may only bind to a loopback address.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('WebSocket listen endpoint cannot contain query or hash.');
  }
  if (url.pathname === '/healthz' || url.pathname === '/readyz') {
    throw new Error(`WebSocket route ${url.pathname} conflicts with health.`);
  }
  return {
    kind: 'websocket',
    routePath: url.pathname,
    host: url.hostname,
    port: Number(url.port || 80),
  };
}

async function closeListener(
  app: FastifyInstance,
  address: ListenerAddress,
  connections: Set<Promise<void>>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await app.close();
  } catch (error) {
    failures.push(error);
  }
  const settled = await Promise.allSettled([...connections]);
  for (const result of settled) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (address.socketPath !== undefined) {
    try {
      await unlink(address.socketPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Fastify listener close failed.');
  }
}

function requireSocketPath(address: ListenerAddress): string {
  if (address.socketPath === undefined) {
    throw new Error('Unix listener address has no socket path.');
  }
  return address.socketPath;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isLoopbackRemote(remote: string): boolean {
  return (
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  );
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}
