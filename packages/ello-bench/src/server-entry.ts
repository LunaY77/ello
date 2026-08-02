#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { createContainerLocalAgentRuntime } from './infra/runtime.js';
import { startBenchmarkServer } from './infra/server.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' },
    socket: { type: 'string' },
    workspace: { type: 'string' },
    'raw-root': { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});

const root = required(values.root, '--root');
const socketPath = required(values.socket, '--socket');
const workspace = required(values.workspace, '--workspace');
const rawRoot = required(values['raw-root'], '--raw-root');
await mkdir(rawRoot, { recursive: true });
const server = await startBenchmarkServer({
  root,
  socketPath,
  runtime: createContainerLocalAgentRuntime({
    rawRoot,
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
});

function required(value: string | undefined, option: string): string {
  if (value === undefined || value === '')
    throw new Error(`${option} is required.`);
  return value;
}
