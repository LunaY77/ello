import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { createTransport } from '../../src/client/connection.js';

describe('Client connection transports', () => {
  let root: string | undefined;
  let httpServer: HttpServer | undefined;
  let webSocketServer: WebSocketServer | undefined;

  afterEach(async () => {
    await closeWebSocketServer(webSocketServer);
    await closeHttpServer(httpServer);
    if (root !== undefined) await rm(root, { force: true, recursive: true });
  });

  it('把 auth token 传给 Unix WebSocket Upgrade', async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-tui-unix-'));
    const socketPath = join(root, 'agent:test.sock');
    let authorization: string | undefined;
    httpServer = createServer();
    webSocketServer = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
      authorization = request.headers.authorization;
      webSocketServer?.handleUpgrade(request, socket, head, () => undefined);
    });
    await listenUnix(httpServer, socketPath);

    const transport = await createTransport({
      endpoint: `unix://${socketPath}`,
      authToken: 'test-token',
    });
    expect(transport.kind).toBe('unix');
    expect(authorization).toBe('Bearer test-token');

    await transport.close();
  });
});

function listenUnix(server: HttpServer, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeWebSocketServer(
  server: WebSocketServer | undefined,
): Promise<void> {
  if (server === undefined) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeHttpServer(server: HttpServer | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
