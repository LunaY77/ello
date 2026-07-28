#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import type { DockerShellEvent } from './docker-shell.js';
import { createBenchmarkAgentRuntime } from './runtime.js';
import { startBenchmarkServer } from './server.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' },
    socket: { type: 'string' },
    workspace: { type: 'string' },
    runtime: { type: 'string' },
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
const runtime = requiredRuntime(values.runtime);
const rawRoot = required(values['raw-root'], '--raw-root');
const hasParentChannel = typeof process.send === 'function';
await mkdir(rawRoot, { recursive: true });
const shellLogPath = path.join(rawRoot, 'shell-events.jsonl');
let shellWrites = Promise.resolve();
const runtimeOptions =
  runtime === 'docker'
    ? {
        runtime,
        containerName: required(values.container, '--container'),
        containerWorkspace: required(
          values['container-workspace'],
          '--container-workspace',
        ),
        shellMode: requiredShellMode(values['shell-mode']),
        recordShell: (event: DockerShellEvent) => {
          shellWrites = shellWrites.then(() =>
            appendFile(shellLogPath, `${JSON.stringify(event)}\n`, 'utf8'),
          );
          return shellWrites;
        },
      }
    : { runtime };
const server = await startBenchmarkServer({
  root,
  socketPath,
  runtime: createBenchmarkAgentRuntime({
    workspace,
    rawRoot,
    ...runtimeOptions,
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

function requiredRuntime(value: string | undefined): 'docker' | 'local' {
  if (value !== 'docker' && value !== 'local') {
    throw new Error('--runtime must be docker or local.');
  }
  return value;
}
