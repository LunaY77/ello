import { fileURLToPath } from 'node:url';

import {
  ELLO_PROTOCOL_VERSION,
  type InitializeParamsSchema,
} from '@ello/agent/protocol';
import type { z } from 'zod';

import { AppServerClient } from '../api/client.js';
import type { ClientTransport } from '../api/transport.js';
import { StdioChildTransport } from '../api/transports/stdio-child.js';
import { UnixTransport } from '../api/transports/unix.js';
import { WebSocketTransport } from '../api/transports/websocket.js';
import { ELLO_TUI_VERSION } from '../version.js';

type InitializeParams = z.input<typeof InitializeParamsSchema>;

export interface ClientConnectionOptions {
  readonly endpoint?: string;
  readonly root?: string;
  readonly authToken?: string;
  readonly serverEntry?: string;
  readonly requestTimeoutMs?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface ClientConnection {
  readonly client: AppServerClient;
  readonly transport: ClientTransport;
  readonly initialize: Awaited<ReturnType<AppServerClient['initialize']>>;
  close(): Promise<void>;
}

export async function connectClient(
  options: ClientConnectionOptions = {},
): Promise<ClientConnection> {
  const transport = await createTransport(options);
  const client = new AppServerClient({
    transport,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  await client.connect();
  const initialize = await client.initialize(initializeParams(options));
  return {
    client,
    transport,
    initialize,
    close: () => client.close(),
  };
}

export async function createTransport(
  options: ClientConnectionOptions,
): Promise<ClientTransport> {
  const endpoint = options.endpoint ?? 'stdio://';
  if (endpoint === 'stdio://') {
    const entryPath = options.serverEntry ?? resolveServerEntry();
    return new StdioChildTransport({
      entryPath,
      ...(options.root === undefined ? {} : { root: options.root }),
    });
  }
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
    return WebSocketTransport.connect(endpoint, options.authToken);
  }
  if (endpoint.startsWith('unix://')) {
    const socketPath = decodeURIComponent(endpoint.slice('unix://'.length));
    if (socketPath === '')
      throw new Error('unix:// endpoint requires a socket path.');
    return UnixTransport.connect(socketPath, options.authToken);
  }
  throw new Error(`Unsupported App Server endpoint ${endpoint}.`);
}

function initializeParams(options: ClientConnectionOptions): InitializeParams {
  return {
    clientInfo: {
      name: options.clientName ?? 'ello-tui',
      title: 'Ello Terminal Client',
      version: options.clientVersion ?? ELLO_TUI_VERSION,
    },
    protocolVersion: ELLO_PROTOCOL_VERSION,
    capabilities: {
      experimentalApi: false,
      supportsServerRequests: true,
      supportsUserInput: true,
      optOutNotificationMethods: [],
      platform: 'terminal',
    },
  };
}

function resolveServerEntry(): string {
  const resolved = import.meta.resolve('@ello/agent/server-entry');
  return fileURLToPath(resolved);
}
