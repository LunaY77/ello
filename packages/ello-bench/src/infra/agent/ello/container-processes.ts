import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  EnvironmentProcesses,
  ExecRequest,
  ExecResult,
  InspectOptions,
  ProcessExit,
  ProcessObservation,
  ProcessOutputChunk,
  ProcessOutputSnapshot,
  ProcessReference,
  ProcessSignal,
  SpawnRequest,
  WaitOptions,
} from '@ello/agent/runtime';

import type {
  ContainerHandle,
  ContainerProcess,
} from '../../../ports/container.js';

const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_INSPECT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const DEFAULT_SHELL = '/bin/bash';

interface ProcessRecord {
  readonly ref: ProcessReference;
  readonly ownerId: string;
  readonly lifecycle: 'attached' | 'background';
  readonly process: ContainerProcess;
  readonly stdout: BoundedOutput;
  readonly stderr: BoundedOutput;
  readonly completion: Promise<ProcessExit>;
  timeout?: ReturnType<typeof setTimeout>;
  forceTimeout?: ReturnType<typeof setTimeout>;
  exit?: ProcessExit;
  timedOut: boolean;
}

export interface ContainerProcessRegistry {
  createHandle(
    ownerId: string,
    workingDirectory: string,
    assertOpen: () => void,
  ): EnvironmentProcesses;
  closeOwner(ownerId: string): Promise<void>;
  close(): Promise<void>;
}

export function createContainerProcessRegistry(
  container: ContainerHandle,
  environmentRef: string,
  generation: number,
  defaultOutputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
): ContainerProcessRegistry {
  assertPositiveInteger(generation, 'Environment generation');
  assertPositiveInteger(defaultOutputLimitBytes, 'Process output limit');
  return new DefaultContainerProcessRegistry(
    container,
    environmentRef,
    generation,
    defaultOutputLimitBytes,
  );
}

class DefaultContainerProcessRegistry implements ContainerProcessRegistry {
  private readonly records = new Map<ProcessReference, ProcessRecord>();
  private closed = false;

  constructor(
    private readonly container: ContainerHandle,
    private readonly environmentRef: string,
    private readonly generation: number,
    private readonly defaultOutputLimitBytes: number,
  ) {}

  createHandle(
    ownerId: string,
    workingDirectory: string,
    assertOpen: () => void,
  ): EnvironmentProcesses {
    const requireOpen = () => {
      assertOpen();
      if (this.closed) throw new Error('Environment generation is closed.');
    };
    const spawn = async (request: SpawnRequest) => {
      requireOpen();
      return await this.spawn(ownerId, workingDirectory, request);
    };
    return {
      exec: async (request) => {
        const ref = await spawn({
          ...launchRequest(request),
          lifecycle: 'attached',
          maxRuntimeMs: request.maxRuntimeMs,
        });
        const record = this.requireRecord(ref);
        const abort = () => {
          const current = this.records.get(ref);
          if (current !== undefined) {
            void this.terminate([current]).catch(() => undefined);
          }
        };
        if (request.signal?.aborted === true) abort();
        else request.signal?.addEventListener('abort', abort, { once: true });
        try {
          if (request.input === undefined) await record.process.closeStdin();
          const exit = await waitForExit(record.completion, {});
          return execResult(record, exit);
        } finally {
          request.signal?.removeEventListener('abort', abort);
        }
      },
      spawn,
      inspect: async (ref, options) => {
        requireOpen();
        return this.inspect(ref, options);
      },
      write: async (ref, data) => {
        requireOpen();
        await this.write(ref, data);
      },
      closeStdin: async (ref) => {
        requireOpen();
        await this.closeStdin(ref);
      },
      wait: async (ref, options) => {
        requireOpen();
        return await this.wait(ref, options);
      },
      signal: async (ref, signal) => {
        requireOpen();
        await this.signal(ref, signal);
      },
    };
  }

  async closeOwner(ownerId: string): Promise<void> {
    const records = [...this.records.values()].filter(
      (record) => record.ownerId === ownerId && record.lifecycle === 'attached',
    );
    await this.terminate(records);
    for (const record of records) this.records.delete(record.ref);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.terminate([...this.records.values()]);
    this.records.clear();
  }

  private async spawn(
    ownerId: string,
    workingDirectory: string,
    request: SpawnRequest,
  ): Promise<ProcessReference> {
    assertLaunchRequest(request);
    const lifecycle = request.lifecycle ?? 'attached';
    if (lifecycle === 'background' && request.maxRuntimeMs === undefined) {
      throw new Error('Background process requires maxRuntimeMs.');
    }
    if (request.maxRuntimeMs !== undefined) {
      assertPositiveInteger(request.maxRuntimeMs, 'Process maxRuntimeMs');
    }
    const outputLimit =
      request.outputLimitBytes ?? this.defaultOutputLimitBytes;
    assertPositiveInteger(outputLimit, 'Process output limit');
    const cwd = path.posix.resolve(
      workingDirectory,
      request.cwd ?? workingDirectory,
    );
    const command =
      request.args === undefined
        ? [DEFAULT_SHELL, '-lc', `set -o pipefail; ${request.command}`]
        : [request.command, ...request.args];
    const stdout = new BoundedOutput(outputLimit);
    const stderr = new BoundedOutput(outputLimit);
    const process = await this.container.spawn(command, {
      cwd,
      ...(request.env === undefined ? {} : { env: request.env }),
      onStdout: (chunk) => stdout.append(chunk),
      onStderr: (chunk) => stderr.append(chunk),
    });
    const ref = `${this.environmentRef}:${this.generation}:${randomUUID()}`;
    const completion = process.exit.then((exit) => {
      const current = this.records.get(ref);
      if (current !== undefined) clearRecordTimers(current);
      const result: ProcessExit = {
        ...exit,
        timedOut: current?.timedOut ?? false,
      };
      if (current !== undefined) current.exit = result;
      return result;
    });
    const record: ProcessRecord = {
      ref,
      ownerId,
      lifecycle,
      process,
      stdout,
      stderr,
      completion,
      timedOut: false,
    };
    this.records.set(ref, record);
    void completion.catch(() => this.records.delete(ref));
    if (request.maxRuntimeMs !== undefined) {
      record.timeout = setTimeout(() => {
        record.timedOut = true;
        void process.signal('SIGTERM').catch(() => undefined);
        record.forceTimeout = setTimeout(() => {
          void process.signal('SIGKILL').catch(() => undefined);
        }, TERMINATION_GRACE_MS);
        record.forceTimeout.unref();
      }, request.maxRuntimeMs);
      record.timeout.unref();
    }
    if (request.input !== undefined) {
      try {
        await process.write(request.input);
        await process.closeStdin();
      } catch (error) {
        await this.terminate([record]);
        this.records.delete(ref);
        throw error;
      }
    }
    return ref;
  }

  private inspect(
    ref: ProcessReference,
    options: InspectOptions = {},
  ): ProcessObservation {
    const record = this.requireRecord(ref);
    const maxBytes = options.maxBytes ?? DEFAULT_INSPECT_BYTES;
    assertPositiveInteger(maxBytes, 'Process inspect maxBytes');
    const stdout = record.stdout.read(options.stdoutCursor ?? 0, maxBytes);
    const stderr = record.stderr.read(options.stderrCursor ?? 0, maxBytes);
    const exited = record.exit !== undefined;
    return {
      ref,
      status: exited ? 'exited' : 'running',
      stdout: {
        ...stdout,
        complete: exited && stdout.nextCursor >= stdout.totalBytes,
      },
      stderr: {
        ...stderr,
        complete: exited && stderr.nextCursor >= stderr.totalBytes,
      },
      ...(record.exit === undefined ? {} : { exit: record.exit }),
    };
  }

  private async write(ref: ProcessReference, data: Uint8Array): Promise<void> {
    await this.requireRunningRecord(ref).process.write(data);
  }

  private async closeStdin(ref: ProcessReference): Promise<void> {
    const record = this.requireRecord(ref);
    if (record.exit === undefined) await record.process.closeStdin();
  }

  private async wait(
    ref: ProcessReference,
    options: WaitOptions = {},
  ): Promise<ProcessExit> {
    return await waitForExit(this.requireRecord(ref).completion, options);
  }

  private async signal(
    ref: ProcessReference,
    signal: ProcessSignal,
  ): Promise<void> {
    const record = this.requireRecord(ref);
    if (record.exit === undefined) await record.process.signal(signal);
  }

  private requireRecord(ref: ProcessReference): ProcessRecord {
    const record = this.records.get(ref);
    if (record === undefined) {
      throw new Error(`Unknown process reference for this generation: ${ref}`);
    }
    return record;
  }

  private requireRunningRecord(ref: ProcessReference): ProcessRecord {
    const record = this.requireRecord(ref);
    if (record.exit !== undefined) {
      throw new Error(`Environment process has already exited: ${ref}`);
    }
    return record;
  }

  private async terminate(records: readonly ProcessRecord[]): Promise<void> {
    const running = records.filter((record) => record.exit === undefined);
    await Promise.allSettled(
      running.map((record) => record.process.signal('SIGTERM')),
    );
    await Promise.race([
      Promise.allSettled(running.map((record) => record.completion)),
      delay(TERMINATION_GRACE_MS),
    ]);
    const remaining = running.filter((record) => record.exit === undefined);
    await Promise.allSettled(
      remaining.map((record) => record.process.signal('SIGKILL')),
    );
    await Promise.allSettled(remaining.map((record) => record.completion));
  }
}

class BoundedOutput {
  private retained = Buffer.alloc(0);
  private total = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Uint8Array): void {
    this.total += chunk.byteLength;
    const buffer = Buffer.from(chunk);
    if (buffer.byteLength >= this.limit) {
      this.retained = Buffer.from(
        buffer.subarray(buffer.byteLength - this.limit),
      );
      return;
    }
    const combined = Buffer.concat([this.retained, buffer]);
    this.retained =
      combined.byteLength <= this.limit
        ? combined
        : combined.subarray(combined.byteLength - this.limit);
  }

  snapshot(): ProcessOutputSnapshot {
    return {
      data: Uint8Array.from(this.retained),
      totalBytes: this.total,
      truncatedBytes: this.total - this.retained.byteLength,
    };
  }

  read(cursor: number, maxBytes: number): Omit<ProcessOutputChunk, 'complete'> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error('Process output cursor must be a non-negative integer.');
    }
    const retainedStart = this.total - this.retained.byteLength;
    const actualStart = Math.min(this.total, Math.max(cursor, retainedStart));
    const offset = actualStart - retainedStart;
    const data = this.retained.subarray(offset, offset + maxBytes);
    return {
      data: Uint8Array.from(data),
      cursor: actualStart,
      nextCursor: actualStart + data.byteLength,
      totalBytes: this.total,
      truncatedBytes: retainedStart,
    };
  }
}

function launchRequest(
  request: ExecRequest,
): Omit<SpawnRequest, 'lifecycle' | 'maxRuntimeMs'> {
  return {
    command: request.command,
    ...(request.args === undefined ? {} : { args: request.args }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.outputLimitBytes === undefined
      ? {}
      : { outputLimitBytes: request.outputLimitBytes }),
  };
}

function execResult(record: ProcessRecord, exit: ProcessExit): ExecResult {
  return {
    ...exit,
    stdout: record.stdout.snapshot(),
    stderr: record.stderr.snapshot(),
  };
}

function assertLaunchRequest(request: {
  readonly command: string;
  readonly args?: readonly string[];
}): void {
  if (request.command.trim() === '')
    throw new Error('Process command is empty.');
  if (
    request.command.includes('\0') ||
    request.args?.some((arg) => arg.includes('\0')) === true
  ) {
    throw new Error('Process command contains a null byte.');
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function clearRecordTimers(record: ProcessRecord): void {
  if (record.timeout !== undefined) clearTimeout(record.timeout);
  if (record.forceTimeout !== undefined) clearTimeout(record.forceTimeout);
}

async function waitForExit(
  completion: Promise<ProcessExit>,
  options: WaitOptions,
): Promise<ProcessExit> {
  if (options.timeoutMs !== undefined) {
    assertPositiveInteger(options.timeoutMs, 'Process wait timeoutMs');
  }
  if (options.signal?.aborted === true) {
    throw options.signal.reason ?? new Error('Process wait aborted.');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(
        () =>
          reject(
            new Error(`Process wait timed out after ${options.timeoutMs} ms.`),
          ),
        options.timeoutMs,
      );
      timeout.unref();
    }
    if (options.signal !== undefined) {
      abort = () =>
        reject(options.signal?.reason ?? new Error('Process wait aborted.'));
      options.signal.addEventListener('abort', abort, { once: true });
    }
  });
  try {
    return await Promise.race([completion, interruption]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abort !== undefined) {
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref();
  });
}
