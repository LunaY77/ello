import type { ProcessResult } from '../domain/contract/index.js';

export type PullPolicy = 'if-absent' | 'always' | 'never';

export interface ContainerSpec {
  readonly image: string;
  readonly name: string;
  readonly workspaceMount: {
    readonly host: string;
    readonly container: '/app';
  };
  readonly network: 'none' | 'bridge';
  readonly cpus: number;
  readonly memoryMb: number;
  readonly storageMb: number;
  readonly env: Readonly<Record<string, string>>;
  readonly user: { readonly uid: number; readonly gid: number };
  readonly entrypoint?: string;
  readonly command: readonly string[];
}

export interface ContainerExecOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string | Uint8Array;
  readonly timeoutMs: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
}

export interface ContainerExecResult {
  readonly process: ProcessResult;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type ContainerProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export interface ContainerSpawnOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly onStdout: (chunk: Uint8Array) => void;
  readonly onStderr: (chunk: Uint8Array) => void;
}

export interface ContainerProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
}

/** Container adapter 内部持有的流式进程；不会暴露给 Agent 或模型。 */
export interface ContainerProcess {
  readonly exit: Promise<ContainerProcessExit>;
  write(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  signal(signal: ContainerProcessSignal): Promise<void>;
}

export interface ContainerHandle {
  readonly name: string;
  readonly workspace: '/app';
  readonly storagePolicy: {
    readonly enforcement: 'workspace-and-writable-layer-watchdog';
    readonly accounting: readonly [
      'bind-workspace-apparent-bytes',
      'container-size-rw',
    ];
    readonly limitBytes: number;
    readonly intervalMs: number;
  };
  exec(
    command: readonly string[],
    options: ContainerExecOptions,
  ): Promise<ContainerExecResult>;
  spawn(
    command: readonly string[],
    options: ContainerSpawnOptions,
  ): Promise<ContainerProcess>;
  copyIn(hostPath: string, containerPath: string): Promise<void>;
  copyOut(containerPath: string, hostPath: string): Promise<void>;
  assertStorageLimit(): Promise<void>;
  remove(): Promise<void>;
}

export interface ImageProvenance {
  readonly image: string;
  readonly imageId: string;
  readonly pullPolicy: PullPolicy;
}

export interface ContainerRuntime {
  ensureImage(image: string, policy: PullPolicy): Promise<ImageProvenance>;
  start(spec: ContainerSpec): Promise<ContainerHandle>;
}
