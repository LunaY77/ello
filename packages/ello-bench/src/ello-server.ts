import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { ContainerShellMode } from './container-shell.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
type ServerChild = ChildProcess & {
  readonly stdout: Readable;
  readonly stderr: Readable;
};

export interface BenchmarkServerProcess {
  readonly endpoint: string;
  readonly pid: number;
  close(): Promise<void>;
}

interface BenchmarkServerProcessOptionsBase {
  readonly workspace: string;
  readonly elloHome: string;
  readonly socketPath: string;
  readonly rawRoot: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export type BenchmarkServerProcessOptions = BenchmarkServerProcessOptionsBase &
  (
    | { readonly runtime: 'local' }
    | {
        readonly runtime: 'docker';
        readonly containerName: string;
        readonly containerWorkspace: string;
        readonly shellMode: ContainerShellMode;
      }
  );

export async function startBenchmarkServerProcess(
  options: BenchmarkServerProcessOptions,
): Promise<BenchmarkServerProcess> {
  const entry = path.join(packageRoot, 'dist', 'server-entry.js');
  await access(entry);
  await Promise.all([
    mkdir(path.dirname(options.stdoutPath), { recursive: true }),
    mkdir(path.dirname(options.stderrPath), { recursive: true }),
  ]);
  const spawned = spawn(
    process.execPath,
    [
      entry,
      '--root',
      options.elloHome,
      '--socket',
      options.socketPath,
      '--workspace',
      options.workspace,
      '--runtime',
      options.runtime,
      ...(options.runtime === 'docker'
        ? [
            '--container',
            options.containerName,
            '--container-workspace',
            options.containerWorkspace,
            '--shell-mode',
            options.shellMode,
          ]
        : []),
      '--raw-root',
      options.rawRoot,
    ],
    {
      cwd: options.workspace,
      env: { ...process.env, ELLO_HOME: options.elloHome },
      detached: process.platform !== 'win32',
      // IPC channel closes with the benchmark parent, allowing server-entry to
      // release its listener even when the parent is interrupted or killed.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as const,
      windowsHide: true,
    },
  );
  if (spawned.stdout === null || spawned.stderr === null) {
    throw new Error('Benchmark server did not create output pipes.');
  }
  const child = spawned as ServerChild;
  if (child.pid === undefined)
    throw new Error('Benchmark server has no process id.');
  const stdout = createWriteStream(options.stdoutPath, { flags: 'w' });
  const stderr = createWriteStream(options.stderrPath, { flags: 'w' });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const endpoint = await waitForReady(child, 30_000);
  return {
    endpoint,
    pid: child.pid,
    close: () => closeServerProcess(child),
  };
}

async function waitForReady(
  child: ServerChild,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const settle = (result: { endpoint?: string; error?: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      if (result.error !== undefined) reject(result.error);
      else if (result.endpoint !== undefined) resolve(result.endpoint);
      else
        reject(new Error('Benchmark server readiness produced no endpoint.'));
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          terminate(child.pid, 'SIGKILL');
          settle({
            error: new Error(
              'Benchmark server emitted invalid JSON before readiness.',
              { cause: error },
            ),
          });
          return;
        }
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'event' in parsed &&
          parsed.event === 'benchmark-server.ready' &&
          'endpoint' in parsed &&
          typeof parsed.endpoint === 'string'
        ) {
          settle({ endpoint: parsed.endpoint });
          return;
        }
      }
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      settle({
        error: new Error(
          `Benchmark server exited before readiness: code=${String(code)} signal=${String(signal)}.`,
        ),
      });
    };
    const timeout = setTimeout(() => {
      terminate(child.pid, 'SIGKILL');
      settle({ error: new Error('Benchmark server readiness timed out.') });
    }, timeoutMs);
    timeout.unref();
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

async function closeServerProcess(child: ServerChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0) {
      throw new Error(
        `Benchmark server exited with code ${String(child.exitCode)}.`,
      );
    }
    return;
  }
  terminate(child.pid, 'SIGTERM');
  const completed = await waitForExit(child, 10_000);
  if (!completed) {
    terminate(child.pid, 'SIGKILL');
    await waitForExit(child, 10_000);
  }
  if (child.exitCode !== 0) {
    throw new Error(
      `Benchmark server shutdown failed: code=${String(child.exitCode)} signal=${String(child.signalCode)}.`,
    );
  }
}

async function waitForExit(
  child: ServerChild,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timeout.unref();
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function terminate(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ESRCH'
      )
    ) {
      throw error;
    }
  }
}
