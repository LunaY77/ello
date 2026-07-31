import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  EnvironmentFileStat,
  EnvironmentFileSystem,
  EnvironmentGrant,
  EnvironmentHandle,
  Environments,
  ExecutionLocation,
} from '@ello/agent/runtime';

import type { ContainerHandle } from '../../../ports/container.js';

import {
  createContainerProcessRegistry,
  type ContainerProcessRegistry,
} from './container-processes.js';

const CONTAINER_GENERATION = 1;
const FILE_OUTPUT_LIMIT_BYTES = 128 * 1024 * 1024;

export function createContainerEnvironments(options: {
  readonly container: ContainerHandle;
  readonly processOutputLimitBytes?: number;
}): Environments {
  return new ContainerEnvironments(
    options.container,
    createContainerProcessRegistry(
      options.container,
      options.container.name,
      CONTAINER_GENERATION,
      options.processOutputLimitBytes,
    ),
  );
}

class ContainerEnvironments implements Environments {
  private closed = false;

  constructor(
    private readonly container: ContainerHandle,
    private readonly processes: ContainerProcessRegistry,
  ) {}

  async attach(
    location: ExecutionLocation,
    grant: EnvironmentGrant,
  ): Promise<EnvironmentHandle> {
    if (this.closed) throw new Error('Container Environments is closed.');
    if (location.environmentRef !== this.container.name) {
      throw new Error(
        `Unknown Container Environment Reference: ${location.environmentRef}`,
      );
    }
    if (grant.isolation !== 'none') {
      throw new Error(
        `Unsupported Container Environment isolation grant: ${grant.isolation}`,
      );
    }
    if (!path.posix.isAbsolute(location.workingDirectory)) {
      throw new Error('Environment workingDirectory must be absolute.');
    }
    const workingDirectory = path.posix.resolve(location.workingDirectory);
    const ownerId = randomUUID();
    let handleClosed = false;
    const assertOpen = () => {
      if (this.closed) throw new Error('Environment generation is closed.');
      if (handleClosed) throw new Error('Environment Handle is closed.');
    };
    const fileSystem = createContainerFileSystem(
      this.container,
      workingDirectory,
      assertOpen,
    );
    const directory = await fileSystem.stat(workingDirectory);
    if (directory.kind !== 'directory') {
      throw new Error(
        `Environment workingDirectory is not a directory: ${workingDirectory}`,
      );
    }
    const processes = this.processes.createHandle(
      ownerId,
      workingDirectory,
      assertOpen,
    );
    return {
      environmentRef: this.container.name,
      generation: CONTAINER_GENERATION,
      workingDirectory,
      grant: { ...grant },
      fileSystem,
      processes,
      getInstructions: async () => {
        assertOpen();
        return [
          '<environment-context>',
          `  <environment-reference>${this.container.name}</environment-reference>`,
          `  <generation>${CONTAINER_GENERATION}</generation>`,
          `  <working-directory>${workingDirectory}</working-directory>`,
          '  <isolation>container</isolation>',
          '</environment-context>',
        ].join('\n');
      },
      close: async () => {
        if (handleClosed) return;
        handleClosed = true;
        await this.processes.closeOwner(ownerId);
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.processes.close();
  }
}

function createContainerFileSystem(
  container: ContainerHandle,
  workingDirectory: string,
  assertOpen: () => void,
): EnvironmentFileSystem {
  const resolvePath = (targetPath: string): string => {
    assertOpen();
    if (targetPath === '') throw new Error('Environment path is empty.');
    return path.posix.resolve(workingDirectory, targetPath);
  };
  return {
    resolvePath,
    async stat(targetPath) {
      const resolved = resolvePath(targetPath);
      const result = await container.exec(
        [
          'sh',
          '-c',
          [
            'target=$1',
            'if [ -L "$target" ]; then kind=symlink',
            'elif [ -f "$target" ]; then kind=file',
            'elif [ -d "$target" ]; then kind=directory',
            'elif [ -e "$target" ]; then kind=other',
            'else exit 44',
            'fi',
            'printf "%s\\n" "$kind"',
            'stat --printf "%s\\n%Y\\n%y\\n" -- "$target"',
          ].join('; '),
          'ello-bench-stat',
          resolved,
        ],
        {
          cwd: workingDirectory,
          timeoutMs: 30_000,
          maxOutputBytes: 1024 * 1024,
        },
      );
      requireSuccess(result, `stat ${resolved}`);
      return parseFileStat(result.stdout ?? '', resolved);
    },
    async readFile(targetPath) {
      const resolved = resolvePath(targetPath);
      const result = await container.exec(
        ['sh', '-c', 'base64 < "$1" | tr -d "\\n"', 'ello-bench-read', resolved],
        {
          cwd: workingDirectory,
          timeoutMs: 30_000,
          maxOutputBytes: FILE_OUTPUT_LIMIT_BYTES,
        },
      );
      requireSuccess(result, `read ${resolved}`);
      return Uint8Array.from(Buffer.from(result.stdout ?? '', 'base64'));
    },
    async readText(targetPath) {
      const resolved = resolvePath(targetPath);
      const result = await container.exec(['cat', '--', resolved], {
        cwd: workingDirectory,
        timeoutMs: 30_000,
        maxOutputBytes: FILE_OUTPUT_LIMIT_BYTES,
      });
      requireSuccess(result, `read ${resolved}`);
      return result.stdout ?? '';
    },
    async writeFile(targetPath, content) {
      await writeContainerFile(
        container,
        workingDirectory,
        resolvePath(targetPath),
        content,
      );
    },
    async writeText(targetPath, content) {
      await writeContainerFile(
        container,
        workingDirectory,
        resolvePath(targetPath),
        content,
      );
    },
    async listDir(targetPath) {
      const resolved = resolvePath(targetPath);
      const result = await container.exec(
        [
          'find',
          resolved,
          '-mindepth',
          '1',
          '-maxdepth',
          '1',
          '-printf',
          '%f\\0',
        ],
        {
          cwd: workingDirectory,
          timeoutMs: 30_000,
          maxOutputBytes: FILE_OUTPUT_LIMIT_BYTES,
        },
      );
      requireSuccess(result, `list ${resolved}`);
      return (result.stdout ?? '')
        .split('\0')
        .filter((entry) => entry !== '')
        .sort((left, right) => left.localeCompare(right));
    },
    async remove(targetPath) {
      const resolved = resolvePath(targetPath);
      const result = await container.exec(
        [
          'sh',
          '-c',
          'if [ -d "$1" ] && [ ! -L "$1" ]; then rmdir -- "$1"; else rm -- "$1"; fi',
          'ello-bench-remove',
          resolved,
        ],
        { cwd: workingDirectory, timeoutMs: 30_000 },
      );
      requireSuccess(result, `remove ${resolved}`);
    },
  };
}

async function writeContainerFile(
  container: ContainerHandle,
  workingDirectory: string,
  targetPath: string,
  content: string | Uint8Array,
): Promise<void> {
  const result = await container.exec(
    [
      'sh',
      '-c',
      'mkdir -p "$(dirname "$1")" && cat > "$1"',
      'ello-bench-write',
      targetPath,
    ],
    {
      cwd: workingDirectory,
      input: content,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    },
  );
  requireSuccess(result, `write ${targetPath}`);
}

function parseFileStat(output: string, targetPath: string): EnvironmentFileStat {
  const [kind, sizeValue, modifiedValue, modifiedText] = output
    .trimEnd()
    .split('\n');
  if (
    kind !== 'file' &&
    kind !== 'directory' &&
    kind !== 'symlink' &&
    kind !== 'other'
  ) {
    throw new Error(`Container stat returned an invalid kind for ${targetPath}.`);
  }
  const size = Number(sizeValue);
  const modifiedSeconds = Number(modifiedValue);
  const fractional = /\.(\d{1,9})\s/u.exec(modifiedText ?? '')?.[1] ?? '';
  const modifiedMilliseconds = Number(fractional.padEnd(3, '0').slice(0, 3));
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isSafeInteger(modifiedSeconds) ||
    !Number.isSafeInteger(modifiedMilliseconds)
  ) {
    throw new Error(`Container stat returned invalid metadata for ${targetPath}.`);
  }
  return {
    kind,
    size,
    modifiedAtMs: modifiedSeconds * 1_000 + modifiedMilliseconds,
  };
}

function requireSuccess(
  result: Awaited<ReturnType<ContainerHandle['exec']>>,
  operation: string,
): void {
  if (result.process.exitCode !== 0 || result.process.timedOut) {
    throw new Error(
      `Container ${operation} failed: ${result.stderr ?? `exit ${String(result.process.exitCode)}`}`,
    );
  }
}
