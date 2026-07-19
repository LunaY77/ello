#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { Capability } from '../protocol/v1/index.js';

import { bootstrapAgentServer } from './bootstrap.js';
import { listenEndpoint, type ServerListener } from './transport/listeners.js';
import { StdioTransport } from './transport/stdio.js';

export async function runServerEntry(
  argv = process.argv.slice(2),
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      listen: { type: 'string' },
      root: { type: 'string' },
      'auth-token-env': { type: 'string' },
      capabilities: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const listen = values.listen;
  if (listen === undefined) throw new Error('--listen is required.');
  const kind =
    listen === 'stdio://'
      ? 'stdio'
      : listen.startsWith('ws://') || listen.startsWith('wss://')
        ? 'websocket'
        : listen.startsWith('unix://')
          ? 'unix'
          : undefined;
  if (kind === undefined)
    throw new Error(`Unsupported listen endpoint: ${listen}`);
  const authToken =
    values['auth-token-env'] === undefined
      ? undefined
      : readAuthToken(values['auth-token-env']);
  const capabilities = parseCapabilities(values.capabilities);
  const server = await bootstrapAgentServer({
    transports: [kind],
    ...(values.root === undefined ? {} : { root: values.root }),
  });
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    void server.stop(reason).catch((error: unknown) => {
      writeFailure(error);
      process.exitCode = 1;
    });
  };
  const onSigterm = () => stop('SIGTERM');
  const onSigint = () => stop('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  try {
    await server.start();
    if (listen === 'stdio://') {
      const transport = new StdioTransport();
      await server.acceptTransport(transport, [
        'read',
        'submit',
        'approve',
        'write',
        'admin',
      ]);
      await server.stop('stdio EOF');
      return;
    }
    const listener = await listenEndpoint({
      endpoint: listen,
      server,
      ...(authToken === undefined ? {} : { authToken }),
      capabilities,
    });
    await waitForServerStop(server, listener);
  } finally {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
  }
}

function parseCapabilities(value: string | undefined): readonly Capability[] {
  if (value === undefined)
    return ['read', 'submit', 'approve', 'write', 'admin'];
  const allowed = new Set<Capability>([
    'read',
    'submit',
    'approve',
    'write',
    'admin',
  ]);
  const capabilities = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (
    capabilities.length === 0 ||
    capabilities.some((entry) => !allowed.has(entry as Capability))
  ) {
    throw new Error(`Invalid capability list ${value}.`);
  }
  return [...new Set(capabilities as Capability[])];
}

function readAuthToken(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '')
    throw new Error(
      `Authentication token environment variable ${name} is empty.`,
    );
  return value;
}

async function waitForServerStop(
  server: Awaited<ReturnType<typeof bootstrapAgentServer>>,
  listener: ServerListener,
): Promise<void> {
  try {
    await server.waitUntilStopped();
  } finally {
    await listener.close();
  }
}

function writeFailure(error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event: 'server.failed',
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === invokedPath
) {
  runServerEntry().catch((error: unknown) => {
    writeFailure(error);
    process.exitCode = 1;
  });
}
