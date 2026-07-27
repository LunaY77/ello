#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createBenchmarkAgentRuntime } from './runtime.js';
import { startBenchmarkServer } from './server.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' },
    socket: { type: 'string' },
    workspace: { type: 'string' },
    container: { type: 'string' },
    'container-workspace': { type: 'string' },
    'shell-mode': { type: 'string' },
    'raw-root': { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});

const root = required(values.root, '--root');
const socketPath = required(values.socket, '--socket');
const workspace = required(values.workspace, '--workspace');
const containerName = required(values.container, '--container');
const containerWorkspace = required(
  values['container-workspace'],
  '--container-workspace',
);
const shellMode = requiredShellMode(values['shell-mode']);
const rawRoot = required(values['raw-root'], '--raw-root');
await mkdir(rawRoot, { recursive: true });
const shellLogPath = path.join(rawRoot, 'shell-events.jsonl');
let shellWrites = Promise.resolve();
const server = await startBenchmarkServer({
  root,
  socketPath,
  runtime: createBenchmarkAgentRuntime({
    workspace,
    containerName,
    containerWorkspace,
    shellMode,
    rawRoot,
    recordShell: (event) => {
      shellWrites = shellWrites.then(() =>
        appendFile(shellLogPath, `${JSON.stringify(event)}\n`, 'utf8'),
      );
      return shellWrites;
    },
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

function requiredShellMode(
  value: string | undefined,
): 'login' | 'preserve-environment' {
  if (value !== 'login' && value !== 'preserve-environment') {
    throw new Error('--shell-mode must be login or preserve-environment.');
  }
  return value;
}
