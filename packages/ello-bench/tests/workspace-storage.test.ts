import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ello-bench-storage-'));
  directories.push(directory);
  return directory;
}
