import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  Environment,
  type FileOperator,
  type Shell,
  type ShellResult,
} from './base.js';

/** 容器挂载配置。 */
export interface Mount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** 运行命令并收集 stdout/stderr。 */
async function runProcess(
  command: string,
  args: string[],
  options: { input?: string; timeout?: number } = {},
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutId =
      options.timeout === undefined
        ? null
        : setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            child.kill();
            resolve({ exitCode: -1, stdout, stderr: 'Timeout' });
          }, options.timeout);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

/**
 * 通过 docker exec 在容器中执行命令。
 *
 * Args:
 *   containerId: 容器 ID。
 *   workdir: 容器内工作目录。
 */
export class DockerShell implements Shell {
  constructor(
    private readonly containerId: string,
    private readonly workdir = '/workspace',
  ) {}

  async run(
    command: string,
    options: { cwd?: string; timeout?: number } = {},
  ): Promise<ShellResult> {
    const work = options.cwd ?? this.workdir;
    return runProcess(
      'docker',
      ['exec', '-w', work, this.containerId, 'sh', '-c', command],
      options.timeout === undefined ? {} : { timeout: options.timeout },
    );
  }
}

/**
 * 通过 docker exec/cp 读写容器内文件。
 *
 * Args:
 *   containerId: 容器 ID。
 *   workdir: 容器内基础路径。
 */
export class DockerFileOperator implements FileOperator {
  constructor(
    private readonly containerId: string,
    private readonly workdir = '/workspace',
  ) {}

  private resolve(targetPath: string): string {
    if (targetPath.startsWith('/')) {
      return targetPath;
    }
    return `${this.workdir}/${targetPath}`;
  }

  async readText(targetPath: string): Promise<string> {
    const resolved = this.resolve(targetPath);
    const result = await runProcess('docker', [
      'exec',
      this.containerId,
      'cat',
      resolved,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`File not found in container: ${resolved}`);
    }
    return result.stdout;
  }

  async writeText(targetPath: string, content: string): Promise<void> {
    const resolved = this.resolve(targetPath);
    const parent = path.posix.dirname(resolved);
    await runProcess('docker', [
      'exec',
      this.containerId,
      'mkdir',
      '-p',
      parent,
    ]);
    await runProcess(
      'docker',
      ['exec', '-i', this.containerId, 'sh', '-c', `cat > ${resolved}`],
      { input: content },
    );
  }

  async listDir(targetPath: string): Promise<string[]> {
    const resolved = this.resolve(targetPath);
    const result = await runProcess('docker', [
      'exec',
      this.containerId,
      'ls',
      resolved,
    ]);
    return result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .sort();
  }
}

/**
 * Docker 容器沙箱环境。
 *
 * Args:
 *   image: Docker 镜像名。
 *   mounts: 挂载列表。
 *   workdir: 容器内工作目录。
 */
export class SandboxEnvironment extends Environment {
  private readonly image: string;
  private readonly mounts: Mount[];
  private readonly workdir: string;
  private containerId: string | null = null;

  constructor(options: { image: string; mounts?: Mount[]; workdir?: string }) {
    super();
    this.image = options.image;
    this.mounts = options.mounts ?? [];
    this.workdir = options.workdir ?? '/workspace';
  }

  protected async setup(): Promise<void> {
    const mountArgs = this.mounts.flatMap((mount) => [
      '-v',
      `${mount.hostPath}:${mount.containerPath}:${mount.readonly ? 'ro' : 'rw'}`,
    ]);
    const result = await runProcess('docker', [
      'run',
      '-d',
      '--rm',
      '-w',
      this.workdir,
      ...mountArgs,
      this.image,
      'sleep',
      'infinity',
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start container: ${result.stderr}`);
    }
    this.containerId = result.stdout.trim();
    this.shellValue = new DockerShell(this.containerId, this.workdir);
    this.fileOperatorValue = new DockerFileOperator(
      this.containerId,
      this.workdir,
    );
  }

  protected async teardown(): Promise<void> {
    if (this.containerId !== null) {
      await runProcess('docker', ['stop', this.containerId]);
      this.containerId = null;
    }
  }

  async getContextInstructions(): Promise<string> {
    if (!this.entered) {
      throw new Error('Environment has not been entered.');
    }
    return `<environment type="sandbox" image="${this.image}" workdir="${this.workdir}" />`;
  }
}
