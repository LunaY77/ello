#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { attachDockerContainer } from './infra/container/docker.js';
import { createBenchmarkAgentRuntime } from './infra/runtime.js';
import { startBenchmarkServer } from './infra/server.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' },
    socket: { type: 'string' },
    workspace: { type: 'string' },
    container: { type: 'string' },
    'raw-root': { type: 'string' },
    'storage-mb': { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});

const root = required(values.root, '--root');
const socketPath = required(values.socket, '--socket');
const workspace = required(values.workspace, '--workspace');
const container = required(values.container, '--container');
const rawRoot = required(values['raw-root'], '--raw-root');
const storageMb = positiveNumber(
  required(values['storage-mb'], '--storage-mb'),
  '--storage-mb',
);
const hasParentChannel = typeof process.send === 'function';
await mkdir(rawRoot, { recursive: true });
const attachedContainer = attachDockerContainer(
  container,
  workspace,
  storageMb,
);
const server = await startBenchmarkServer({
  root,
  socketPath,
  runtime: createBenchmarkAgentRuntime({
    rawRoot,
    container: attachedContainer,
  }),
});

process.stdout.write(
  `${JSON.stringify({ event: 'benchmark-server.ready', endpoint: server.endpoint })}\n`,
);

await new Promise<void>((resolve) => {
  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
      process.stdout.write(
        `${JSON.stringify({ event: 'benchmark-server.closed', signal })}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
      resolve();
    }
  };
  process.once('SIGTERM', () => void close('SIGTERM'));
  process.once('SIGINT', () => void close('SIGINT'));
  if (hasParentChannel) {
    if (process.connected) {
      process.once('disconnect', () => void close('parent-disconnect'));
    } else {
      void close('parent-disconnect');
    }
  }
});
try {
  await attachedContainer.assertStorageLimit();
} finally {
  await attachedContainer.stopStorageMonitoring();
}

function required(value: string | undefined, option: string): string {
  if (value === undefined || value === '')
    throw new Error(`${option} is required.`);
  return value;
}

function positiveNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number.`);
  }
  return parsed;
}
