import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export const STORAGE_WATCHDOG_INTERVAL_MS = 10_000;

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

export class WorkspaceStorageWatchdog {
  private timer: ReturnType<typeof setInterval> | undefined;
  private checks: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  constructor(
    readonly workspace: string,
    readonly limitBytes: number,
    readonly intervalMs = STORAGE_WATCHDOG_INTERVAL_MS,
    private readonly onExceeded: () => Promise<void> = () => Promise.resolve(),
    private readonly additionalBytes: () => Promise<number> = () =>
      Promise.resolve(0),
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error(
        'Workspace storage limit must be a positive safe integer.',
      );
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('Workspace storage interval must be a positive integer.');
    }
  }

  async start(): Promise<void> {
    if (this.timer !== undefined) {
      throw new Error(
        `Workspace storage watchdog already started: ${this.workspace}`,
      );
    }
    await this.assertWithinLimit();
    this.timer = setInterval(() => void this.scheduleCheck(), this.intervalMs);
    this.timer.unref();
  }

  async assertWithinLimit(): Promise<void> {
    await this.scheduleCheck();
    if (this.failure !== undefined) throw this.failure;
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.checks;
  }

  private scheduleCheck(): Promise<void> {
    this.checks = this.checks.then(async () => {
      if (this.failure !== undefined) return;
      try {
        const observedBytes =
          (await apparentDirectoryBytes(this.workspace)) +
          (await this.additionalBytes());
        if (!Number.isSafeInteger(observedBytes) || observedBytes < 0) {
          throw new Error(
            `Workspace storage measurement is invalid: ${observedBytes}.`,
          );
        }
        if (observedBytes <= this.limitBytes) return;
        this.failure = new WorkspaceStorageLimitError(
          this.workspace,
          this.limitBytes,
          observedBytes,
        );
        try {
          await this.onExceeded();
        } catch (error) {
          this.failure = new AggregateError(
            [this.failure, error],
            `Workspace storage limit enforcement failed: ${this.workspace}.`,
          );
        }
      } catch (error) {
        this.failure =
          error instanceof Error
            ? error
            : new Error(
                `Workspace storage measurement failed: ${String(error)}`,
              );
      }
    });
    return this.checks;
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
