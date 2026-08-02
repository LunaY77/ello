import { chmod, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { spawnManagedProcess } from '../src/infra/managed-process.js';
import { runProcess } from '../src/infra/process.js';
import type {
  ContainerExecOptions,
  ContainerHandle,
  ContainerProcess,
  ContainerSpawnOptions,
} from '../src/ports/container.js';

export class FakeContainerHandle implements ContainerHandle {
  readonly name = 'bench-container';
  readonly workspace = '/app' as const;
  readonly storagePolicy = {
    enforcement: 'workspace-and-writable-layer-watchdog' as const,
    accounting: ['bind-workspace-apparent-bytes', 'container-size-rw'] as const,
    limitBytes: Number.MAX_SAFE_INTEGER,
    intervalMs: 10_000,
  };

  constructor(
    private readonly hostWorkspace: string,
    private readonly containerRoot: string,
  ) {}

  async exec(command: readonly string[], options: ContainerExecOptions) {
    const executable = command[0];
    if (executable === undefined)
      throw new Error('Container command is empty.');
    if (executable === 'mkdir' && command[1] === '-p') {
      await Promise.all(
        command
          .slice(2)
          .map((value) => mkdir(this.mapPath(value), { recursive: true })),
      );
      return success(command);
    }
    if (executable === 'chmod') {
      const mode = command[1];
      const target = command[2];
      if (mode === undefined || target === undefined) {
        throw new Error('Invalid fake chmod command.');
      }
      await chmod(this.mapPath(target), Number.parseInt(mode, 8));
      return success(command);
    }
    const mappedCommand = this.mapPath(executable);
    const mappedArgs = command.slice(1).map((value) => this.mapArgument(value));
    const execution = await runProcess(mappedCommand, mappedArgs, {
      cwd: this.mapPath(options.cwd),
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(options.env ?? {}).map(([key, value]) => [
            key,
            this.mapArgument(value),
          ]),
        ),
      },
      ...(options.input === undefined ? {} : { input: options.input }),
      timeoutMs: options.timeoutMs,
      killGraceMs: options.killGraceMs ?? 500,
      ...(options.stdoutPath === undefined && options.stderrPath === undefined
        ? {
            capture: true as const,
            maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
          }
        : {
            capture: false as const,
            stdoutPath: required(options.stdoutPath, 'stdoutPath'),
            stderrPath: required(options.stderrPath, 'stderrPath'),
          }),
    });
    return {
      process: {
        ...execution.result,
        command: executable,
        args: command.slice(1),
      },
      ...(execution.stdout === undefined ? {} : { stdout: execution.stdout }),
      ...(execution.stderr === undefined ? {} : { stderr: execution.stderr }),
    };
  }

  async spawn(
    command: readonly string[],
    options: ContainerSpawnOptions,
  ): Promise<ContainerProcess> {
    const executable = command[0];
    if (executable === undefined) {
      throw new Error('Container command is empty.');
    }
    return await spawnManagedProcess(
      this.mapPath(executable),
      command.slice(1).map((value) => this.mapArgument(value)),
      {
        cwd: this.mapPath(options.cwd),
        env: {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(options.env ?? {}).map(([key, value]) => [
              key,
              this.mapArgument(value),
            ]),
          ),
        },
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      },
    );
  }

  async copyIn(hostPath: string, containerPath: string): Promise<void> {
    const target = this.mapPath(containerPath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(hostPath, target, { recursive: true });
  }

  async copyOut(containerPath: string, hostPath: string): Promise<void> {
    await mkdir(path.dirname(hostPath), { recursive: true });
    await cp(this.mapPath(containerPath), hostPath);
  }

  assertStorageLimit(): Promise<void> {
    return Promise.resolve();
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }

  private mapArgument(value: string): string {
    if (value === '/app' || value.startsWith('/app/')) {
      return path.join(this.hostWorkspace, value.slice('/app'.length));
    }
    if (value === '/tmp/ello-bench' || value.startsWith('/tmp/ello-bench/')) {
      return path.join(
        this.containerRoot,
        'tmp',
        value.slice('/tmp/ello-bench'.length),
      );
    }
    return value;
  }

  private mapPath(value: string): string {
    return this.mapArgument(value);
  }
}

function success(command: readonly string[]) {
  return {
    process: {
      command: required(command[0], 'command'),
      args: command.slice(1),
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
    stdout: '',
    stderr: '',
  } as const;
}

function required(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}
