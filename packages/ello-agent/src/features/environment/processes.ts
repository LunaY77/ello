/**
 * 本地 Environment generation 的进程登记、输出缓冲和进程树生命周期实现。
 *
 * Process Reference 只定位本 registry 内记录，不暴露 PID；每个 Handle 只拥有自己创建的
 * attached 进程，background 进程则持续到最大运行时间或 Environment 关闭。
 */
import {
  spawn as spawnChild,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
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
} from './contracts.js';

const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_INSPECT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const DEFAULT_SHELL = '/bin/bash';

interface ProcessRecord {
  readonly ref: ProcessReference;
  readonly ownerId: string;
  readonly lifecycle: 'attached' | 'background';
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: BoundedOutput;
  readonly stderr: BoundedOutput;
  readonly completion: Promise<ProcessExit>;
  timeout?: ReturnType<typeof setTimeout>;
  forceTimeout?: ReturnType<typeof setTimeout>;
  exit?: ProcessExit;
  timedOut: boolean;
}

export interface LocalProcessRegistry {
  /**
   * 创建绑定 Handle 所有权和工作目录的进程能力。
   *
   * Args:
   * - `ownerId`: 当前 Handle 的内部身份。
   * - `workingDirectory`: 进程相对 cwd 的解析基准。
   * - `assertOpen`: 每次操作前校验 Handle 有效性。
   *
   * Returns:
   * - 返回统一的前台与受管进程接口。
   */
  createHandle(
    ownerId: string,
    workingDirectory: string,
    assertOpen: () => void,
  ): EnvironmentProcesses;
  /**
   * 终止指定 Handle 创建的全部 attached 进程。
   *
   * Args:
   * - `ownerId`: 要释放的 Handle 内部身份。
   *
   * Returns:
   * - Promise 在相关进程树退出后兑现。
   */
  closeOwner(ownerId: string): Promise<void>;
  /**
   * 终止 generation 内全部进程并拒绝后续操作。
   *
   * Args:
   * - 无：关闭范围是当前 registry 的完整 generation。
   *
   * Returns:
   * - Promise 在全部进程树退出后兑现。
   */
  close(): Promise<void>;
}

/**
 * 创建一个 Environment generation 共用的本地进程 registry。
 *
 * Args:
 * - `environmentRef`: Process Reference 的诊断前缀，不包含底层 PID。
 * - `generation`: 所有进程引用绑定的 generation。
 * - `shellExecutable`: shell 文本请求使用的可执行文件。
 * - `defaultOutputLimitBytes`: 未显式设置时每个输出流保留的最大字节数。
 *
 * Returns:
 * - 返回可为多个 Handle 创建进程能力的内部 registry。
 */
export function createLocalProcessRegistry(
  environmentRef: string,
  generation: number,
  shellExecutable = DEFAULT_SHELL,
  defaultOutputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
): LocalProcessRegistry {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Environment generation must be a positive integer.');
  }
  assertPositiveInteger(defaultOutputLimitBytes, 'Process output limit');
  return new DefaultLocalProcessRegistry(
    environmentRef,
    generation,
    shellExecutable,
    defaultOutputLimitBytes,
  );
}

class DefaultLocalProcessRegistry implements LocalProcessRegistry {
  private readonly records = new Map<ProcessReference, ProcessRecord>();
  private closed = false;

  constructor(
    private readonly environmentRef: string,
    private readonly generation: number,
    private readonly shellExecutable: string,
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
          if (request.input === undefined) await endStdin(record.child);
          const exit = await record.completion;
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

  /**
   * 关闭当前 generation 的全部进程。
   *
   * Args:
   * - 无：重复关闭直接返回。
   *
   * Returns:
   * - Promise 在全部进程树退出后兑现。
   */
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
    const cwd = path.resolve(workingDirectory, request.cwd ?? workingDirectory);
    const command =
      request.args === undefined ? this.shellExecutable : request.command;
    const args =
      request.args === undefined ? ['-lc', request.command] : [...request.args];
    const child = spawnChild(command, args, {
      cwd,
      env: { ...process.env, ...request.env },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const ref = `${this.environmentRef}:${this.generation}:${randomUUID()}`;
    const stdout = new BoundedOutput(outputLimit);
    const stderr = new BoundedOutput(outputLimit);
    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
    const startedAt = performance.now();
    let resolveCompletion!: (exit: ProcessExit) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<ProcessExit>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);
    const record: ProcessRecord = {
      ref,
      ownerId,
      lifecycle,
      child,
      stdout,
      stderr,
      completion,
      timedOut: false,
    };
    this.records.set(ref, record);
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearRecordTimers(record);
      this.records.delete(ref);
      rejectCompletion(error);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearRecordTimers(record);
      const exit: ProcessExit = {
        exitCode,
        signal,
        timedOut: record.timedOut,
        durationMs: performance.now() - startedAt,
      };
      record.exit = exit;
      resolveCompletion(exit);
    });
    if (request.maxRuntimeMs !== undefined) {
      record.timeout = setTimeout(() => {
        record.timedOut = true;
        signalProcessTree(child.pid, 'SIGTERM');
        record.forceTimeout = setTimeout(() => {
          signalProcessTree(child.pid, 'SIGKILL');
        }, TERMINATION_GRACE_MS);
        record.forceTimeout.unref();
      }, request.maxRuntimeMs);
      record.timeout.unref();
    }
    try {
      await spawned(child);
    } catch (error) {
      this.records.delete(ref);
      throw error;
    }
    if (request.input !== undefined) {
      try {
        await endStdin(child, request.input);
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
    const record = this.requireRunningRecord(ref);
    await new Promise<void>((resolve, reject) => {
      record.child.stdin.write(data, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private async closeStdin(ref: ProcessReference): Promise<void> {
    const record = this.requireRecord(ref);
    if (record.exit !== undefined || record.child.stdin.destroyed) return;
    await endStdin(record.child);
  }

  private async wait(
    ref: ProcessReference,
    options: WaitOptions = {},
  ): Promise<ProcessExit> {
    const completion = this.requireRecord(ref).completion;
    return await waitForExit(completion, options);
  }

  private signal(ref: ProcessReference, signal: ProcessSignal): Promise<void> {
    const record = this.requireRecord(ref);
    if (record.exit === undefined) signalProcessTree(record.child.pid, signal);
    return Promise.resolve();
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
    for (const record of running) {
      signalProcessTree(record.child.pid, 'SIGTERM');
    }
    await Promise.race([
      Promise.allSettled(running.map((record) => record.completion)),
      delay(TERMINATION_GRACE_MS),
    ]);
    const remaining = running.filter((record) => record.exit === undefined);
    for (const record of remaining) {
      signalProcessTree(record.child.pid, 'SIGKILL');
    }
    await Promise.allSettled(remaining.map((record) => record.completion));
  }
}

class BoundedOutput {
  private retained = Buffer.alloc(0);
  private total = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.total += chunk.byteLength;
    if (chunk.byteLength >= this.limit) {
      this.retained = Buffer.from(
        chunk.subarray(chunk.byteLength - this.limit),
      );
      return;
    }
    const combined = Buffer.concat([this.retained, chunk]);
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

function assertLaunchRequest(request: ProcessLaunchRequest): void {
  if (request.command.trim() === '')
    throw new Error('Process command is empty.');
  if (
    request.args !== undefined &&
    request.args.some((arg) => arg.includes('\0'))
  ) {
    throw new Error('Process argument contains a null byte.');
  }
}

interface ProcessLaunchRequest {
  readonly command: string;
  readonly args?: readonly string[];
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function spawned(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function endStdin(
  child: ChildProcessWithoutNullStreams,
  data?: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.end(data, (error?: Error | null) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function signalProcessTree(
  pid: number | undefined,
  signal: ProcessSignal,
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

function clearRecordTimers(record: ProcessRecord): void {
  if (record.timeout !== undefined) clearTimeout(record.timeout);
  if (record.forceTimeout !== undefined) clearTimeout(record.forceTimeout);
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
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
    if (abort !== undefined)
      options.signal?.removeEventListener('abort', abort);
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref();
  });
}
