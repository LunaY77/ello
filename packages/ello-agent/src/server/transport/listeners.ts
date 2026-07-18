import { chmod, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';

import { WebSocketServer } from 'ws';

import { AgentServer } from '../server.js';

import type { AppServerTransport } from './transport.js';
import { UnixSocketTransport } from './unix-socket.js';
import { WebSocketTransport } from './websocket.js';

export interface ListenerOptions {
  readonly endpoint: string;
  readonly authToken?: string;
  readonly capabilities: readonly import('../../protocol/v1/index.js').Capability[];
  readonly server: AgentServer;
}

export interface ServerListener {
  close(): Promise<void>;
}

export async function listenEndpoint(options: ListenerOptions): Promise<ServerListener> {
  if (options.endpoint.startsWith('ws://') || options.endpoint.startsWith('wss://')) {
    return listenWebSocket(options);
  }
  if (options.endpoint.startsWith('unix://')) {
    return listenUnix(options);
  }
  throw new Error(`Unsupported listen endpoint: ${options.endpoint}`);
}

async function listenWebSocket(options: ListenerOptions): Promise<ServerListener> {
  const url = new URL(options.endpoint);
  if (url.protocol !== 'ws:') throw new Error('wss:// server endpoints require TLS configuration and are not enabled.');
  if (!isLoopbackHost(url.hostname)) throw new Error('ws:// listeners may only bind to a loopback address.');
  const httpServer = createServer((request, response) => {
    if (request.url === '/healthz' || request.url === '/readyz') {
      const ready = options.server.state === 'ready';
      response.statusCode = ready ? 200 : 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: ready ? 'ready' : options.server.state }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  const sockets = new WebSocketServer({ noServer: true });
  const transports = new Set<AppServerTransport>();
  const connections = new Set<Promise<void>>();
  httpServer.on('upgrade', (request, socket, head) => {
    if (request.headers.origin !== undefined) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authorize(request, options.authToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      trackConnection(
        new WebSocketTransport(webSocket),
        options,
        transports,
        connections,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(Number(url.port || 80), url.hostname, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  return {
    close: async () => {
      await closeTransports(sockets, transports, connections);
      await closeHttpServer(httpServer);
    },
  };
}

async function listenUnix(options: ListenerOptions): Promise<ServerListener> {
  const socketPath = decodeURIComponent(options.endpoint.slice('unix://'.length));
  if (socketPath === '') throw new Error('unix:// endpoint requires a socket path.');
  const httpServer = createServer((request, response) => {
    if (request.url === '/healthz' || request.url === '/readyz') {
      const ready = options.server.state === 'ready';
      response.statusCode = ready ? 200 : 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: ready ? 'ready' : options.server.state }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  const sockets = new WebSocketServer({ noServer: true });
  const transports = new Set<AppServerTransport>();
  const connections = new Set<Promise<void>>();
  httpServer.on('upgrade', (request, socket, head) => {
    if (!authorizeUnix(request, options.authToken)) {
      socket.write(options.authToken === undefined
        ? 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'
        : 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      trackConnection(
        new UnixSocketTransport(webSocket),
        options,
        transports,
        connections,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(socketPath, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return {
    close: async () => {
      await closeTransports(sockets, transports, connections);
      await closeHttpServer(httpServer);
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

function trackConnection(
  transport: AppServerTransport,
  options: ListenerOptions,
  transports: Set<AppServerTransport>,
  connections: Set<Promise<void>>,
): void {
  transports.add(transport);
  const task = options.server
    .acceptTransport(transport, options.capabilities)
    .finally(() => {
      transports.delete(transport);
      connections.delete(task);
    });
  connections.add(task);
}

async function closeTransports(
  sockets: WebSocketServer,
  transports: Set<AppServerTransport>,
  connections: Set<Promise<void>>,
): Promise<void> {
  sockets.close();
  await Promise.allSettled(
    [...transports].map((transport) => transport.close('listener closed')),
  );
  await Promise.allSettled([...connections]);
}

function authorize(request: IncomingMessage, authToken: string | undefined): boolean {
  const remote = request.socket.remoteAddress;
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (authToken === undefined && !loopback) return false;
  if (authToken === undefined) return true;
  return request.headers.authorization === `Bearer ${authToken}`;
}

function authorizeUnix(request: IncomingMessage, authToken: string | undefined): boolean {
  if (authToken === undefined) return true;
  return request.headers.authorization === `Bearer ${authToken}`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
