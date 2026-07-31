import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  ContainerExecOptions,
  ContainerHandle,
  ContainerProcess,
  ContainerProcessExit,
  ContainerProcessSignal,
  ContainerRuntime,
  ContainerSpawnOptions,
  ContainerSpec,
  ImageProvenance,
  PullPolicy,
} from '../../ports/container.js';
import { spawnManagedProcess } from '../managed-process.js';
import { runChecked, runProcess } from '../process.js';
import {
  STORAGE_WATCHDOG_INTERVAL_MS,
  WorkspaceStorageWatchdog,
} from '../workspace-storage.js';

const DOCKER_TIMEOUT = {
  timeoutMs: 10 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 128 * 1024 * 1024,
} as const;

const CONTAINER_PROCESS_WRAPPER = String.raw`
pid_file=$1
shift
printf 'tree %s\n' "$$" > "$pid_file"
exec "$@"
`.trim();

const SIGNAL_CONTAINER_PROCESS = String.raw`
pid_file=$1
signal=$2
if ! read -r mode root_pid < "$pid_file" 2>/dev/null; then
  exit 0
fi
case "$root_pid" in
  ''|*[!0-9]*) exit 64 ;;
esac
if [ ! -d "/proc/$root_pid" ]; then
  exit 0
fi
if [ "$mode" != tree ]; then
  exit 64
fi
children_of() {
  parent_pid=$1
  for status_file in /proc/[0-9]*/status; do
    child_pid=
    child_parent=
    while read -r key value rest; do
      case "$key" in
        Pid:) child_pid=$value ;;
        PPid:) child_parent=$value ;;
      esac
    done < "$status_file" 2>/dev/null || true
    if [ "$child_parent" = "$parent_pid" ]; then
      printf '%s\n' "$child_pid"
    fi
  done
}
tree_pids=$root_pid
frontier=$root_pid
while [ -n "$frontier" ]; do
  next=
  for parent_pid in $frontier; do
    for child_pid in $(children_of "$parent_pid"); do
      tree_pids="$tree_pids $child_pid"
      next="$next $child_pid"
    done
  done
  frontier=$next
done
for tree_pid in $tree_pids; do
  kill "-$signal" "$tree_pid" 2>/dev/null || true
done
`.trim();

export class DockerContainerRuntime implements ContainerRuntime {
  async ensureImage(
    image: string,
    policy: PullPolicy,
  ): Promise<ImageProvenance> {
    const inspect = async () =>
      runProcess('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
        cwd: process.cwd(),
        capture: true,
        timeoutMs: 30_000,
        killGraceMs: 5_000,
        maxOutputBytes: 16 * 1024 * 1024,
      });
    let inspected = await inspect();
    const present =
      inspected.result.exitCode === 0 && !inspected.result.timedOut;
    if (policy === 'always' || (!present && policy === 'if-absent')) {
      await runChecked('docker', ['pull', image], {
        cwd: process.cwd(),
        timeoutMs: 30 * 60_000,
        killGraceMs: 5_000,
        maxOutputBytes: 256 * 1024 * 1024,
      });
      inspected = await inspect();
    } else if (!present) {
      throw new Error(
        `Docker image is absent and pull policy is never: ${image}`,
      );
    }
    const imageId = inspected.stdout?.trim();
    if (
      inspected.result.exitCode !== 0 ||
      inspected.result.timedOut ||
      imageId === undefined ||
      imageId === ''
    ) {
      throw new Error(`Cannot resolve Docker image id: ${image}`);
    }
    return { image, imageId, pullPolicy: policy };
  }

  async start(spec: ContainerSpec): Promise<ContainerHandle> {
    await removeDockerContainer(spec.name);
    const args = dockerRunArgs(spec);
    await runChecked('docker', args, {
      cwd: spec.workspaceMount.host,
      ...DOCKER_TIMEOUT,
    });
    const handle = new DockerContainerHandle(
      spec.name,
      spec.workspaceMount.host,
      spec.storageMb * 1024 * 1024,
    );
    try {
      await handle.start();
      return handle;
    } catch (error) {
      await handle.remove();
      throw error;
    }
  }
}

export class DockerContainerHandle implements ContainerHandle {
  readonly workspace = '/app' as const;
  readonly storagePolicy;
  private readonly storage: WorkspaceStorageWatchdog;

  constructor(
    readonly name: string,
    hostWorkspace: string,
    limitBytes: number,
  ) {
    this.storagePolicy = {
      enforcement: 'workspace-and-writable-layer-watchdog' as const,
      accounting: [
        'bind-workspace-apparent-bytes',
        'container-size-rw',
      ] as const,
      limitBytes,
      intervalMs: STORAGE_WATCHDOG_INTERVAL_MS,
    };
    this.storage = new WorkspaceStorageWatchdog(
      hostWorkspace,
      limitBytes,
      STORAGE_WATCHDOG_INTERVAL_MS,
      () => removeDockerContainer(this.name),
      () => dockerContainerWritableBytes(this.name),
    );
  }

  start(): Promise<void> {
    return this.storage.start();
  }

  async exec(command: readonly string[], options: ContainerExecOptions) {
    if (command.length === 0) throw new Error('Container command is empty.');
    const args = [
      'exec',
      ...(options.input === undefined ? [] : ['-i']),
      '--workdir',
      options.cwd,
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => [
        '--env',
        `${key}=${value}`,
      ]),
      this.name,
      ...command,
    ];
    const capture =
      options.stdoutPath === undefined && options.stderrPath === undefined;
    const execution = await runProcess(
      'docker',
      args,
      capture
        ? {
            cwd: process.cwd(),
            capture: true,
            ...(options.input === undefined ? {} : { input: options.input }),
            timeoutMs: options.timeoutMs,
            killGraceMs: options.killGraceMs ?? 5_000,
            maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
          }
        : {
            cwd: process.cwd(),
            capture: false,
            ...(options.input === undefined ? {} : { input: options.input }),
            timeoutMs: options.timeoutMs,
            killGraceMs: options.killGraceMs ?? 5_000,
            stdoutPath: requiredPath(options.stdoutPath, 'stdoutPath'),
            stderrPath: requiredPath(options.stderrPath, 'stderrPath'),
          },
    );
    return {
      process: {
        ...execution.result,
        command: requiredCommand(command[0]),
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
    if (command.length === 0) throw new Error('Container command is empty.');
    const processId = randomUUID();
    const pidFile = `/tmp/ello-bench-process-${processId}.pid`;
    const args = [
      'exec',
      '-i',
      '--workdir',
      options.cwd,
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => [
        '--env',
        `${key}=${value}`,
      ]),
      this.name,
      'sh',
      '-c',
      CONTAINER_PROCESS_WRAPPER,
      'ello-bench-process',
      pidFile,
      ...command,
    ];
    const transport = await spawnManagedProcess('docker', args, {
      cwd: process.cwd(),
      env: process.env,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
    const requestedSignals = new Set<ContainerProcessSignal>();
    const exit = transport.exit.then((result) =>
      normalizeContainerProcessExit(result, requestedSignals),
    );
    void exit.then(
      () => removeContainerProcessFile(this.name, pidFile),
      () => removeContainerProcessFile(this.name, pidFile),
    );
    return {
      exit,
      write: (data) => transport.write(data),
      closeStdin: () => transport.closeStdin(),
      signal: async (signal) => {
        requestedSignals.add(signal);
        try {
          await signalContainerProcess(this.name, pidFile, signal, exit);
        } catch (error) {
          requestedSignals.delete(signal);
          throw error;
        }
      },
    };
  }

  async copyIn(hostPath: string, containerPath: string): Promise<void> {
    await runChecked(
      'docker',
      ['cp', path.resolve(hostPath), `${this.name}:${containerPath}`],
      {
        cwd: process.cwd(),
        ...DOCKER_TIMEOUT,
      },
    );
  }

  async copyOut(containerPath: string, hostPath: string): Promise<void> {
    await runChecked(
      'docker',
      ['cp', `${this.name}:${containerPath}`, path.resolve(hostPath)],
      {
        cwd: process.cwd(),
        ...DOCKER_TIMEOUT,
      },
    );
  }

  assertStorageLimit(): Promise<void> {
    return this.storage.assertWithinLimit();
  }

  stopStorageMonitoring(): Promise<void> {
    return this.storage.stop();
  }

  async remove(): Promise<void> {
    await this.storage.stop();
    await removeDockerContainer(this.name);
  }
}

async function signalContainerProcess(
  containerName: string,
  pidFile: string,
  signal: ContainerProcessSignal,
  exit: Promise<ContainerProcessExit>,
): Promise<void> {
  const completed = Symbol('completed');
  const waitForPid = async (): Promise<'ready' | typeof completed> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = await runProcess(
        'docker',
        [
          'exec',
          containerName,
          'sh',
          '-c',
          'test -s "$1"',
          'ello-bench-process-probe',
          pidFile,
        ],
        {
          cwd: process.cwd(),
          capture: true,
          timeoutMs: 5_000,
          killGraceMs: 500,
          maxOutputBytes: 1024 * 1024,
        },
      );
      if (probe.result.exitCode === 0 && !probe.result.timedOut) return 'ready';
      const state = await Promise.race([
        exit.then(() => completed),
        delay(10).then(() => 'waiting' as const),
      ]);
      if (state === completed) return completed;
    }
    throw new Error('Container process did not publish its process identity.');
  };
  if ((await waitForPid()) === completed) return;
  const result = await runProcess(
    'docker',
    [
      'exec',
      containerName,
      'sh',
      '-c',
      SIGNAL_CONTAINER_PROCESS,
      'ello-bench-process-signal',
      pidFile,
      signal.replace(/^SIG/, ''),
    ],
    {
      cwd: process.cwd(),
      capture: true,
      timeoutMs: 30_000,
      killGraceMs: 1_000,
      maxOutputBytes: 1024 * 1024,
    },
  );
  if (result.result.exitCode !== 0 || result.result.timedOut) {
    throw new Error(
      `Cannot signal process in Docker container ${containerName}: ${result.stderr ?? ''}`,
    );
  }
}

async function removeContainerProcessFile(
  containerName: string,
  pidFile: string,
): Promise<void> {
  try {
    await runProcess(
      'docker',
      ['exec', containerName, 'rm', '-f', '--', pidFile],
      {
        cwd: process.cwd(),
        capture: true,
        timeoutMs: 5_000,
        killGraceMs: 500,
        maxOutputBytes: 1024 * 1024,
      },
    );
  } catch {
    // Container shutdown owns any remaining temporary pid file.
  }
}

function normalizeContainerProcessExit(
  exit: ContainerProcessExit,
  requestedSignals: ReadonlySet<ContainerProcessSignal>,
): ContainerProcessExit {
  if (exit.signal === null && exit.exitCode !== null) {
    for (const requestedSignal of requestedSignals) {
      if (exit.exitCode === 128 + signalNumber(requestedSignal)) {
        return { ...exit, exitCode: null, signal: requestedSignal };
      }
    }
  }
  return exit;
}

function signalNumber(signal: ContainerProcessSignal): number {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    case 'SIGKILL':
      return 9;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref();
  });
}

export function attachDockerContainer(
  name: string,
  hostWorkspace: string,
  storageMb: number,
): DockerContainerHandle {
  return new DockerContainerHandle(
    name,
    hostWorkspace,
    storageMb * 1024 * 1024,
  );
}

export function dockerRunArgs(spec: ContainerSpec): string[] {
  const args = [
    'run',
    '-d',
    '--init',
    '--name',
    spec.name,
    '--user',
    `${spec.user.uid}:${spec.user.gid}`,
    '--network',
    spec.network,
    '--cpus',
    String(spec.cpus),
    '--memory',
    `${spec.memoryMb}m`,
    '--mount',
    `type=bind,source=${path.resolve(spec.workspaceMount.host)},target=${spec.workspaceMount.container}`,
    '--workdir',
    spec.workspaceMount.container,
    ...Object.entries(spec.env).flatMap(([key, value]) => [
      '--env',
      `${key}=${value}`,
    ]),
  ];
  if (spec.entrypoint !== undefined) {
    args.push('--entrypoint', spec.entrypoint);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

export async function removeDockerContainer(name: string): Promise<void> {
  const inspected = await runProcess('docker', ['container', 'inspect', name], {
    cwd: process.cwd(),
    capture: true,
    timeoutMs: 30_000,
    killGraceMs: 5_000,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  if (inspected.result.exitCode !== 0 || inspected.result.timedOut) {
    if (
      !inspected.result.timedOut &&
      inspected.stderr?.includes('No such container')
    ) {
      return;
    }
    throw new Error(
      `Docker container inspect failed: ${inspected.stderr ?? ''}`,
    );
  }
  await runChecked('docker', ['rm', '-f', name], {
    cwd: process.cwd(),
    timeoutMs: 120_000,
    killGraceMs: 5_000,
    maxOutputBytes: 16 * 1024 * 1024,
  });
}

export async function dockerContainerWritableBytes(
  name: string,
): Promise<number> {
  const inspected = await runProcess(
    'docker',
    ['container', 'inspect', '--size', '--format', '{{.SizeRw}}', name],
    {
      cwd: process.cwd(),
      capture: true,
      timeoutMs: 30_000,
      killGraceMs: 5_000,
      maxOutputBytes: 1024 * 1024,
    },
  );
  if (inspected.result.exitCode !== 0 || inspected.result.timedOut) {
    if (
      !inspected.result.timedOut &&
      inspected.stderr?.includes('No such container')
    ) {
      return 0;
    }
    throw new Error(
      `Docker container size inspect failed: ${inspected.stderr ?? ''}`,
    );
  }
  const bytes = Number(inspected.stdout?.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(
      `Docker container size inspect returned an invalid value: ${inspected.stdout ?? ''}`,
    );
  }
  return bytes;
}

function requiredPath(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`Container exec requires ${name}.`);
  return value;
}

function requiredCommand(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error('Container command is empty.');
  }
  return value;
}
