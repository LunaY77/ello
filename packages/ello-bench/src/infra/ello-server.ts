import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ContainerHandle, ContainerProcess } from '../ports/container.js';

import { CONTAINER_ELLO_RUNTIME_ROOT } from './agent/container-paths.js';

export interface BenchmarkServerProcess {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface BenchmarkServerProcessOptions {
  readonly container: ContainerHandle;
  readonly workspace: '/app';
  readonly elloHome: string;
  readonly socketPath: string;
  readonly rawRoot: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly env: Readonly<Record<string, string>>;
}

export async function startBenchmarkServerProcess(
  options: BenchmarkServerProcessOptions,
): Promise<BenchmarkServerProcess> {
  await Promise.all([
    mkdir(path.dirname(options.stdoutPath), { recursive: true }),
    mkdir(path.dirname(options.stderrPath), { recursive: true }),
  ]);
  const stdout = createWriteStream(options.stdoutPath, { flags: 'w' });
  const stderr = createWriteStream(options.stderrPath, { flags: 'w' });
  let parseReady!: (chunk: Uint8Array) => void;
  const ready = new Promise<string>((resolve, reject) => {
    let buffer = '';
    parseReady = (chunk) => {
      buffer += Buffer.from(chunk).toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (
            parsed.event === 'benchmark-server.ready' &&
            typeof parsed.endpoint === 'string'
          ) {
            resolve(parsed.endpoint);
            return;
          }
        } catch (error) {
          reject(
            new Error('Benchmark server emitted invalid readiness JSON.', {
              cause: error,
            }),
          );
          return;
        }
      }
    };
  });
  const process = await options.container.spawn(
    [
      `${CONTAINER_ELLO_RUNTIME_ROOT}/node`,
      `${CONTAINER_ELLO_RUNTIME_ROOT}/packages/ello-bench/dist/server-entry.js`,
      '--root',
      options.elloHome,
      '--socket',
      options.socketPath,
      '--workspace',
      options.workspace,
      '--raw-root',
      options.rawRoot,
    ],
    {
      cwd: options.workspace,
      env: { ...options.env, ELLO_HOME: options.elloHome },
      onStdout: (chunk) => {
        stdout.write(chunk);
        parseReady(chunk);
      },
      onStderr: (chunk) => stderr.write(chunk),
    },
  );
  process.exit.then(
    (exit) => {
      if (exit.exitCode !== 0) {
        stderr.write(
          `Benchmark server exited: code=${String(exit.exitCode)} signal=${String(exit.signal)}\n`,
        );
      }
    },
    (error: unknown) => stderr.write(`${String(error)}\n`),
  );
  let endpoint: string;
  try {
    endpoint = await withTimeout(
      Promise.race([
        ready,
        process.exit.then((exit) => {
          throw new Error(
            `Benchmark server exited before readiness: code=${String(exit.exitCode)} signal=${String(exit.signal)}.`,
          );
        }),
      ]),
      30_000,
      'Benchmark server readiness timed out.',
    );
  } catch (error) {
    await process.signal('SIGKILL');
    stdout.end();
    stderr.end();
    throw error;
  }
  return {
    endpoint,
    async close() {
      await closeContainerProcess(process);
      stdout.end();
      stderr.end();
    },
  };
}

async function closeContainerProcess(process: ContainerProcess): Promise<void> {
  const settled = await Promise.race([
    process.exit.then(() => true),
    delay(0).then(() => false),
  ]);
  if (!settled) await process.signal('SIGTERM');
  const graceful = await Promise.race([
    process.exit.then(() => true),
    delay(10_000).then(() => false),
  ]);
  if (!graceful) await process.signal('SIGKILL');
  const exit = await process.exit;
  if (exit.exitCode !== 0 && exit.signal !== 'SIGTERM') {
    throw new Error(
      `Benchmark server shutdown failed: code=${String(exit.exitCode)} signal=${String(exit.signal)}.`,
    );
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return await Promise.race([
    operation,
    delay(timeoutMs).then(() => {
      throw new Error(message);
    }),
  ]);
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref();
  });
}
