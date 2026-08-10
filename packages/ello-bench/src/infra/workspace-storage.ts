import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export const STORAGE_WATCHDOG_INTERVAL_MS = 10_000;

/**
 * Cleanup must not inherit the latency of an in-flight storage measurement.
 * `stop()` waits at most this long for the single bounded check that is already
 * running, then abandons its result so container removal can proceed.
 */
export const STORAGE_WATCHDOG_STOP_WAIT_MS = 5_000;

export class WorkspaceStorageLimitError extends Error {
  constructor(
    readonly workspace: string,
    readonly limitBytes: number,
    readonly observedBytes: number,
  ) {
    super(
      `Workspace storage limit exceeded: ${workspace} uses ${observedBytes} bytes, limit is ${limitBytes} bytes.`,
    );
    this.name = 'WorkspaceStorageLimitError';
  }
}

/**
 * Storage checks are expensive (a full workspace walk plus `docker inspect
 * --size`), so periodic ticks must never accumulate: at most one check runs at a
 * time and at most one additional check is coalesced behind it. Anything else
 * lets a fast interval outrun slow measurements and turns `stop()` into an
 * unbounded wait that blocks container removal and workspace cleanup.
 */
export class WorkspaceStorageWatchdog {
  private timer: ReturnType<typeof setInterval> | undefined;
  private terminalFailure: Error | undefined;
  private measurementFailure: Error | undefined;
  private stopped = false;
  private locked = false;
  private readonly waiting: Array<() => void> = [];
  private running: Promise<void> | undefined;
  private periodicPending = false;

  constructor(
    readonly workspace: string,
    readonly limitBytes: number,
    readonly intervalMs = STORAGE_WATCHDOG_INTERVAL_MS,
    private readonly onExceeded: () => Promise<void> = () => Promise.resolve(),
    private readonly additionalBytes: () => Promise<number> = () =>
      Promise.resolve(0),
    private readonly stopWaitMs = STORAGE_WATCHDOG_STOP_WAIT_MS,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error(
        'Workspace storage limit must be a positive safe integer.',
      );
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('Workspace storage interval must be a positive integer.');
    }
    if (!Number.isSafeInteger(stopWaitMs) || stopWaitMs < 0) {
      throw new Error(
        'Workspace storage stop wait must be a nonnegative safe integer.',
      );
    }
  }

  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error(
        `Workspace storage watchdog already stopped: ${this.workspace}`,
      );
    }
    if (this.timer !== undefined) {
      throw new Error(
        `Workspace storage watchdog already started: ${this.workspace}`,
      );
    }
    await this.assertWithinLimit();
    this.timer = setInterval(
      () => this.schedulePeriodicCheck(),
      this.intervalMs,
    );
    this.timer.unref();
  }

  /**
   * Explicit phase-boundary check. It always takes a fresh measurement and
   * propagates limit and measurement failures to the caller.
   */
  async assertWithinLimit(): Promise<void> {
    await this.runCheck();
    if (this.terminalFailure !== undefined) throw this.terminalFailure;
    if (this.measurementFailure !== undefined) throw this.measurementFailure;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Discard the coalesced check that has not started yet; a queued check also
    // re-reads `stopped` before measuring anything.
    this.periodicPending = false;
    const running = this.running;
    if (running === undefined) return;
    await waitBounded(running, this.stopWaitMs);
  }

  private schedulePeriodicCheck(): void {
    if (this.stopped || this.periodicPending) return;
    this.periodicPending = true;
    void this.runPeriodicCheck();
  }

  private async runPeriodicCheck(): Promise<void> {
    await this.acquire();
    // Cleared once this check starts, so ticks arriving during the measurement
    // coalesce into exactly one successor instead of a growing backlog.
    this.periodicPending = false;
    try {
      if (this.stopped) return;
      await this.measure();
    } finally {
      this.release();
    }
  }

  private async runCheck(): Promise<void> {
    await this.acquire();
    try {
      await this.measure();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.locked = false;
      return;
    }
    next();
  }

  /** Runs under the lock, so `running` tracks a single bounded measurement. */
  private measure(): Promise<void> {
    const check = this.takeMeasurement().finally(() => {
      if (this.running === check) this.running = undefined;
    });
    this.running = check;
    return check;
  }

  private async takeMeasurement(): Promise<void> {
    if (this.terminalFailure !== undefined) return;
    try {
      const observedBytes =
        (await apparentDirectoryBytes(this.workspace)) +
        (await this.additionalBytes());
      this.measurementFailure = undefined;
      if (!Number.isSafeInteger(observedBytes) || observedBytes < 0) {
        throw new Error(
          `Workspace storage measurement is invalid: ${observedBytes}.`,
        );
      }
      if (observedBytes <= this.limitBytes) return;
      this.terminalFailure = new WorkspaceStorageLimitError(
        this.workspace,
        this.limitBytes,
        observedBytes,
      );
      try {
        await this.onExceeded();
      } catch (error) {
        this.terminalFailure = new AggregateError(
          [this.terminalFailure, error],
          `Workspace storage limit enforcement failed: ${this.workspace}.`,
        );
      }
    } catch (error) {
      this.measurementFailure =
        error instanceof Error
          ? error
          : new Error(`Workspace storage measurement failed: ${String(error)}`);
    }
  }
}

async function waitBounded(
  work: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function apparentDirectoryBytes(root: string): Promise<number> {
  const pending = [path.resolve(root)];
  const seen = new Set<string>();
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if (current !== path.resolve(root) && isMissingPath(error)) continue;
      throw error;
    }
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    bytes += Number(metadata.size);
    if (!Number.isSafeInteger(bytes)) {
      throw new Error(
        `Workspace storage measurement exceeds safe integer range: ${root}.`,
      );
    }
    if (!metadata.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    for (const entry of entries) pending.push(path.join(current, entry));
  }
  return bytes;
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
