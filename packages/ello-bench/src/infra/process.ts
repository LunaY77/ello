import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  ProcessResultSchema,
  type ProcessResult,
} from '../domain/contract/index.js';

interface CommonProcessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
}

export type RunProcessOptions = CommonProcessOptions &
  (
    | {
        readonly capture: true;
        readonly maxOutputBytes: number;
        readonly stdoutPath?: string;
        readonly stderrPath?: string;
      }
    | {
        readonly capture: false;
        readonly stdoutPath: string;
        readonly stderrPath: string;
      }
  );

export interface ProcessExecution {
  readonly result: ProcessResult;
  readonly stdout?: string;
  readonly stderr?: string;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessExecution> {
  if (command === '') throw new Error('Process command must not be empty.');
  if (options.timeoutMs <= 0)
    throw new Error('Process timeout must be positive.');
  if (options.killGraceMs <= 0)
    throw new Error('Process kill grace must be positive.');
  if (options.capture && options.maxOutputBytes <= 0) {
    throw new Error('Captured process output limit must be positive.');
  }
  for (const filePath of [options.stdoutPath, options.stderrPath]) {
    if (filePath !== undefined) {
      await mkdir(path.dirname(filePath), { recursive: true });
    }
  }

  const stdoutFile =
    options.stdoutPath === undefined
      ? undefined
      : createWriteStream(options.stdoutPath, { flags: 'w' });
  const stderrFile =
    options.stderrPath === undefined
      ? undefined
      : createWriteStream(options.stderrPath, { flags: 'w' });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let forceTimeout: ReturnType<typeof setTimeout> | undefined;
  const startedAt = performance.now();

  const child = spawn(command, [...args], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    detached: process.platform !== 'win32',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (child.stdout === null || child.stderr === null) {
    throw new Error(`Process ${command} did not create output pipes.`);
  }
  const childStdout = child.stdout;
  const childStderr = child.stderr;

  let rejectOutput!: (error: Error) => void;
  let outputFailed = false;
  const outputFailure = new Promise<never>((_resolve, reject) => {
    rejectOutput = reject;
    stdoutFile?.once('error', failOutputError);
    stderrFile?.once('error', failOutputError);
  });
  childStdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutFile !== undefined && !stdoutFile.write(chunk)) {
      childStdout.pause();
      stdoutFile.once('drain', () => childStdout.resume());
    }
    if (options.capture) {
      if (stdoutBytes > options.maxOutputBytes) {
        failOutput(`Process stdout exceeded ${options.maxOutputBytes} bytes.`);
        return;
      }
      stdoutChunks.push(chunk);
    }
  });
  childStderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrFile !== undefined && !stderrFile.write(chunk)) {
      childStderr.pause();
      stderrFile.once('drain', () => childStderr.resume());
    }
    if (options.capture) {
      if (stderrBytes > options.maxOutputBytes) {
        failOutput(`Process stderr exceeded ${options.maxOutputBytes} bytes.`);
        return;
      }
      stderrChunks.push(chunk);
    }
  });

  function failOutput(message: string): void {
    failOutputError(new Error(message));
  }

  function failOutputError(error: Error): void {
    if (outputFailed) return;
    outputFailed = true;
    terminateProcessTree(child.pid, 'SIGKILL');
    rejectOutput(error);
  }

  const completion = new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child.pid, 'SIGTERM');
    forceTimeout = setTimeout(() => {
      terminateProcessTree(child.pid, 'SIGKILL');
    }, options.killGraceMs);
    forceTimeout.unref();
  }, options.timeoutMs);
  timeout.unref();

  if (options.input !== undefined) {
    if (child.stdin === null) {
      throw new Error(`Process ${command} has no stdin pipe.`);
    }
    child.stdin.end(options.input);
  }

  try {
    const completed = await Promise.race([completion, outputFailure]);
    const result = ProcessResultSchema.parse({
      command,
      args,
      exitCode: completed.exitCode,
      signal: completed.signal,
      timedOut,
      durationMs: performance.now() - startedAt,
      stdoutBytes,
      stderrBytes,
    });
    return {
      result,
      ...(options.capture
        ? {
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
          }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
    if (forceTimeout !== undefined) clearTimeout(forceTimeout);
    await Promise.all([endStream(stdoutFile), endStream(stderrFile)]);
  }
}

export async function runChecked(
  command: string,
  args: readonly string[],
  options: Omit<CommonProcessOptions, 'env'> & {
    readonly env?: NodeJS.ProcessEnv;
    readonly maxOutputBytes: number;
  },
): Promise<{ readonly result: ProcessResult; readonly stdout: string }> {
  const execution = await runProcess(command, args, {
    ...options,
    capture: true,
    maxOutputBytes: options.maxOutputBytes,
  });
  const stdout = requireCapturedOutput(execution.stdout, command, 'stdout');
  const stderr = requireCapturedOutput(execution.stderr, command, 'stderr');
  if (execution.result.exitCode !== 0 || execution.result.timedOut) {
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`.trim());
  }
  return { result: execution.result, stdout };
}

function requireCapturedOutput(
  value: string | undefined,
  command: string,
  stream: 'stdout' | 'stderr',
): string {
  if (value === undefined) {
    throw new Error(`Captured process ${command} did not return ${stream}.`);
  }
  return value;
}

function terminateProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function endStream(
  stream: ReturnType<typeof createWriteStream> | undefined,
): Promise<void> {
  if (stream === undefined) return;
  if (stream.closed || stream.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}
