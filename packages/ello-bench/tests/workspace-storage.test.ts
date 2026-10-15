import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apparentDirectoryBytes,
  WorkspaceStorageLimitError,
  WorkspaceStorageWatchdog,
} from '../src/infra/workspace-storage.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('workspace storage enforcement', () => {
  it('measures hard links once and does not follow symbolic links', async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, 'source.bin');
    await writeFile(source, Buffer.alloc(1024));
    const beforeLinks = await apparentDirectoryBytes(directory);
    await link(source, path.join(directory, 'hard-link.bin'));
    const afterHardLink = await apparentDirectoryBytes(directory);
    await symlink('/dev/zero', path.join(directory, 'external-link'));
    const afterSymbolicLink = await apparentDirectoryBytes(directory);

    expect(afterHardLink - beforeLinks).toBeLessThan(1024);
    expect(afterSymbolicLink).toBeGreaterThanOrEqual(afterHardLink);
    expect(afterSymbolicLink - afterHardLink).toBeLessThan(1024);
  });

  it('terminates the owner and reports an exceeded limit', async () => {
    const directory = await temporaryDirectory();
    const initial = await apparentDirectoryBytes(directory);
    const terminate = vi.fn(() => Promise.resolve());
    const watchdog = new WorkspaceStorageWatchdog(
      directory,
      initial + 16,
      60_000,
      terminate,
    );
    await watchdog.start();
    await writeFile(path.join(directory, 'large.bin'), Buffer.alloc(1024));

    await expect(watchdog.assertWithinLimit()).rejects.toBeInstanceOf(
      WorkspaceStorageLimitError,
    );
    await expect(watchdog.assertWithinLimit()).rejects.toBeInstanceOf(
      WorkspaceStorageLimitError,
    );
    expect(terminate).toHaveBeenCalledOnce();
    await watchdog.stop();
  });

  it('includes additional writable-layer bytes in the same limit', async () => {
    const directory = await temporaryDirectory();
    const initial = await apparentDirectoryBytes(directory);
    const terminate = vi.fn(() => Promise.resolve());
    const watchdog = new WorkspaceStorageWatchdog(
      directory,
      initial + 16,
      60_000,
      terminate,
      () => Promise.resolve(32),
    );

    await expect(watchdog.start()).rejects.toBeInstanceOf(
      WorkspaceStorageLimitError,
    );
    expect(terminate).toHaveBeenCalledOnce();
    await watchdog.stop();
  });

  it('recovers after a transient measurement failure', async () => {
    const directory = await temporaryDirectory();
    const initial = await apparentDirectoryBytes(directory);
    const additionalBytes = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('transient inspect failure'))
      .mockResolvedValue(0);
    const watchdog = new WorkspaceStorageWatchdog(
      directory,
      initial + 16,
      60_000,
      () => Promise.resolve(),
      additionalBytes,
    );
    await watchdog.start();

    await expect(watchdog.assertWithinLimit()).rejects.toThrow(
      'transient inspect failure',
    );
    await expect(watchdog.assertWithinLimit()).resolves.toBeUndefined();
    await watchdog.stop();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-storage-'));
  directories.push(directory);
  return directory;
}

const INTERVAL_MS = 1_000;
const STOP_WAIT_MS = 500;
const TICK_STORM = 100;

describe('workspace storage watchdog scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces an interval tick storm into one running and one pending check', async () => {
    const inspector = createSlowInspector();
    const watchdog = await startedWatchdog(inspector);

    vi.advanceTimersByTime(INTERVAL_MS * TICK_STORM);
    await inspector.calledTimes(2);
    expect(inspector.calls).toBe(2);
    expect(inspector.maximumActive).toBe(1);

    vi.advanceTimersByTime(INTERVAL_MS * TICK_STORM);
    await flushMicrotasks();
    expect(inspector.calls).toBe(2);

    inspector.release();
    await inspector.calledTimes(3);
    expect(inspector.calls).toBe(3);
    expect(inspector.maximumActive).toBe(1);

    vi.advanceTimersByTime(INTERVAL_MS * TICK_STORM);
    await flushMicrotasks();
    expect(inspector.calls).toBe(3);

    const stopping = watchdog.stop();
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);
    await stopping;
    inspector.release();
  });

  it('waits for the running check but not for a pending one', async () => {
    const inspector = createSlowInspector();
    const watchdog = await startedWatchdog(inspector);
    vi.advanceTimersByTime(INTERVAL_MS);
    await inspector.calledTimes(2);
    vi.advanceTimersByTime(INTERVAL_MS);
    await flushMicrotasks();

    let stopped = false;
    const stopping = watchdog.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    inspector.release();
    await stopping;
    await flushMicrotasks();
    expect(stopped).toBe(true);
    expect(inspector.calls).toBe(2);
  });

  it('abandons a running check that outlives the bounded stop wait', async () => {
    const inspector = createSlowInspector();
    const watchdog = await startedWatchdog(inspector);
    vi.advanceTimersByTime(INTERVAL_MS);
    await inspector.calledTimes(2);
    vi.advanceTimersByTime(INTERVAL_MS);

    const stopping = watchdog.stop();
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);
    await stopping;
    expect(inspector.active).toBe(1);

    inspector.release();
    await flushMicrotasks();
    expect(inspector.calls).toBe(2);
  });

  it('starts no periodic check after stopping', async () => {
    const inspector = createSlowInspector();
    const watchdog = await startedWatchdog(inspector);
    await watchdog.stop();

    vi.advanceTimersByTime(INTERVAL_MS * TICK_STORM);
    await flushMicrotasks();
    expect(inspector.calls).toBe(1);
    await expect(watchdog.start()).rejects.toThrow('already stopped');
  });

  it('lets container removal proceed while an inspect is still hanging', async () => {
    const inspector = createSlowInspector();
    const watchdog = await startedWatchdog(inspector);
    const removeContainer = vi.fn(() => Promise.resolve());
    vi.advanceTimersByTime(INTERVAL_MS);
    await inspector.calledTimes(2);

    // Mirrors DockerContainerHandle.remove(): stop monitoring, then docker rm.
    const removing = watchdog.stop().then(() => removeContainer());
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);
    await removing;

    expect(removeContainer).toHaveBeenCalledOnce();
    expect(inspector.active).toBe(1);
    inspector.release();
  });

  it('propagates an inspect failure from an explicit check', async () => {
    const inspector = createSlowInspector();
    const watchdog = await startedWatchdog(inspector);
    vi.advanceTimersByTime(INTERVAL_MS);
    await inspector.calledTimes(2);

    const asserted = expect(watchdog.assertWithinLimit()).rejects.toThrow(
      'inspect exploded',
    );
    inspector.release();
    await inspector.calledTimes(3);
    inspector.release(new Error('inspect exploded'));
    await asserted;

    await watchdog.stop();
  });

  it('propagates an exceeded limit from an explicit check', async () => {
    const inspector = createSlowInspector();
    const directory = await temporaryDirectory();
    const terminate = vi.fn(() => Promise.resolve());
    const initial = await apparentDirectoryBytes(directory);
    const watchdog = new WorkspaceStorageWatchdog(
      directory,
      initial + 16,
      INTERVAL_MS,
      terminate,
      inspector.additionalBytes,
      STOP_WAIT_MS,
    );
    const starting = watchdog.start();
    await inspector.calledTimes(1);
    inspector.release();
    await starting;

    const asserted = expect(
      watchdog.assertWithinLimit(),
    ).rejects.toBeInstanceOf(WorkspaceStorageLimitError);
    await inspector.calledTimes(2);
    inspector.release(undefined, 1024);
    await asserted;
    expect(terminate).toHaveBeenCalledOnce();

    await watchdog.stop();
  });
});

async function startedWatchdog(
  inspector: SlowInspector,
): Promise<WorkspaceStorageWatchdog> {
  const directory = await temporaryDirectory();
  const watchdog = new WorkspaceStorageWatchdog(
    directory,
    Number.MAX_SAFE_INTEGER,
    INTERVAL_MS,
    () => Promise.resolve(),
    inspector.additionalBytes,
    STOP_WAIT_MS,
  );
  const starting = watchdog.start();
  await inspector.calledTimes(1);
  inspector.release();
  await starting;
  return watchdog;
}

interface SlowInspector {
  readonly additionalBytes: () => Promise<number>;
  readonly calledTimes: (count: number) => Promise<void>;
  readonly release: (failure?: Error, bytes?: number) => void;
  readonly calls: number;
  readonly active: number;
  readonly maximumActive: number;
}

/**
 * Stands in for the serialized `docker inspect --size` call: every measurement
 * blocks until the test releases it, so scheduling is fully observable.
 */
function createSlowInspector(): SlowInspector {
  const pending: Array<(failure: Error | undefined, bytes: number) => void> =
    [];
  let waiters: Array<{ count: number; resolve: () => void }> = [];
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const additionalBytes = (): Promise<number> => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const measurement = new Promise<number>((resolve, reject) => {
      pending.push((failure, bytes) => {
        active -= 1;
        if (failure === undefined) resolve(bytes);
        else reject(failure);
      });
    });
    waiters = waiters.filter((waiter) => {
      if (calls < waiter.count) return true;
      waiter.resolve();
      return false;
    });
    return measurement;
  };
  return {
    additionalBytes,
    calledTimes: (count) =>
      calls >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
    release: (failure, bytes = 0) => {
      const settle = pending.shift();
      if (settle === undefined) {
        throw new Error('No pending storage measurement to release.');
      }
      settle(failure, bytes);
    },
    get calls() {
      return calls;
    },
    get active() {
      return active;
    },
    get maximumActive() {
      return maximumActive;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}
