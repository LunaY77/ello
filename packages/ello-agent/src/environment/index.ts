import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cwd as processCwd } from 'node:process';
import { promisify } from 'node:util';

import type {
  AgentEnvironment,
  AgentFileSystem,
  AgentResource,
  AgentResourceFactory,
  AgentResourceRegistry,
  AgentShell,
} from '../public/types.js';

const execAsync = promisify(exec);

export interface CreateLocalEnvironmentOptions {
  readonly cwd?: string;
  readonly allowedPaths?: string[];
  readonly shellExecutable?: string;
}

export function createLocalShellEnvironment(
  options: CreateLocalEnvironmentOptions = {},
): AgentEnvironment {
  const cwd = path.resolve(options.cwd ?? processCwd());
  const allowedPaths = normalizeAllowedPaths(cwd, options.allowedPaths);
  const fileSystem = new LocalFileSystem({ cwd, allowedPaths });
  const shell = new LocalShell({
    cwd,
    allowedPaths,
    ...(options.shellExecutable !== undefined
      ? { shellExecutable: options.shellExecutable }
      : {}),
  });
  const resources = new DefaultAgentResourceRegistry();
  const environment: AgentEnvironment = {
    fileSystem,
    files: fileSystem,
    shell,
    resources,
    async setup() {
      resources.bind(environment);
      await resources.setupAll();
    },
    async getContextInstructions() {
      const sections = [
        await fileSystem.getContextInstructions?.(),
        await shell.getContextInstructions?.(),
        await resources.getContextInstructions?.(),
      ].filter((section): section is string => Boolean(section));
      if (sections.length === 0) {
        return null;
      }
      return `<environment-context>\n${sections.join('\n\n')}\n</environment-context>`;
    },
    async close() {
      await resources.closeAll();
    },
  };
  resources.bind(environment);
  return environment;
}

export const createLocalEnvironment = createLocalShellEnvironment;

export class DefaultAgentResourceRegistry implements AgentResourceRegistry {
  private readonly resources = new Map<string, AgentResource>();
  private readonly factories = new Map<string, AgentResourceFactory>();
  private environment: AgentEnvironment | undefined;

  bind(environment: AgentEnvironment): void {
    this.environment = environment;
  }

  register(key: string, resource: AgentResource): void {
    this.resources.set(key, resource);
  }

  registerFactory(key: string, factory: AgentResourceFactory): void {
    this.factories.set(key, factory);
  }

  async setupAll(): Promise<void> {
    for (const resource of this.resources.values()) {
      await resource.setup?.();
    }
  }

  get(key: string): AgentResource | undefined {
    return this.resources.get(key);
  }

  async getOrCreate(key: string): Promise<AgentResource> {
    const existing = this.resources.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const factory = this.factories.get(key);
    if (factory === undefined) {
      throw new Error(`No resource or factory registered for key: ${key}`);
    }
    if (this.environment === undefined) {
      throw new Error('Resource registry is not bound to an environment.');
    }
    const resource = await factory(this.environment);
    await resource.setup?.();
    this.resources.set(key, resource);
    return resource;
  }

  keys(): string[] {
    return [...new Set([...this.resources.keys(), ...this.factories.keys()])];
  }

  async getContextInstructions(): Promise<string | null> {
    const sections: string[] = [];
    for (const key of this.resources.keys()) {
      const instructions =
        await this.resources.get(key)?.getContextInstructions?.();
      if (instructions) {
        sections.push(`<resource name="${key}">\n${instructions}\n</resource>`);
      }
    }
    return sections.length === 0
      ? null
      : `<resources>\n${sections.join('\n')}\n</resources>`;
  }

  async closeAll(): Promise<void> {
    for (const resource of [...this.resources.values()].reverse()) {
      await resource.close?.();
    }
    this.resources.clear();
    this.factories.clear();
  }
}

class LocalFileSystem implements AgentFileSystem {
  constructor(
    private readonly options: {
      readonly cwd: string;
      readonly allowedPaths: readonly string[];
    },
  ) {}

  readText(targetPath: string): Promise<string> {
    return readFile(this.resolveAllowedPath(targetPath), 'utf8');
  }

  async writeText(targetPath: string, content: string): Promise<void> {
    const resolved = this.resolveAllowedPath(targetPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf8');
  }

  async listDir(targetPath: string): Promise<string[]> {
    return (await readdir(this.resolveAllowedPath(targetPath))).sort();
  }

  getContextInstructions(): string {
    return [
      '<file-system>',
      `  <working-directory>${this.options.cwd}</working-directory>`,
      ...this.options.allowedPaths.map(
        (allowedPath) => `  <allowed-path>${allowedPath}</allowed-path>`,
      ),
      '</file-system>',
    ].join('\n');
  }

  private resolveAllowedPath(targetPath: string): string {
    const resolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.options.cwd, targetPath);
    const allowed = this.options.allowedPaths.some((allowedPath) => {
      const relative = path.relative(allowedPath, resolved);
      return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
      );
    });
    if (!allowed) {
      throw new Error(`Path not allowed: ${resolved}`);
    }
    return resolved;
  }
}

class LocalShell implements AgentShell {
  constructor(
    private readonly options: {
      readonly cwd: string;
      readonly allowedPaths: readonly string[];
      readonly shellExecutable?: string;
    },
  ) {}

  async run(
    command: string,
    runOptions: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    } = {},
  ) {
    const cwd = this.resolveAllowedCwd(runOptions.cwd);
    try {
      const result = await execAsync(command, {
        cwd,
        timeout: runOptions.timeout,
        env:
          runOptions.env === undefined
            ? process.env
            : { ...process.env, ...runOptions.env },
        ...(this.options.shellExecutable !== undefined
          ? { shell: this.options.shellExecutable }
          : {}),
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };
      return {
        exitCode: err.killed
          ? -1
          : typeof err.code === 'number'
            ? err.code
            : 1,
        stdout: err.stdout ?? '',
        stderr: err.killed ? 'timeout' : (err.stderr ?? err.message),
      };
    }
  }

  getContextInstructions(): string {
    return [
      '<shell>',
      `  <working-directory>${this.options.cwd}</working-directory>`,
      ...this.options.allowedPaths.map(
        (allowedPath) => `  <allowed-path>${allowedPath}</allowed-path>`,
      ),
      ...(this.options.shellExecutable !== undefined
        ? [`  <executable>${this.options.shellExecutable}</executable>`]
        : []),
      '</shell>',
    ].join('\n');
  }

  private resolveAllowedCwd(cwd: string | undefined): string {
    const resolved = cwd === undefined ? this.options.cwd : path.resolve(cwd);
    const allowed = this.options.allowedPaths.some((allowedPath) => {
      const relative = path.relative(allowedPath, resolved);
      return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
      );
    });
    if (!allowed) {
      throw new Error(`Shell cwd not allowed: ${resolved}`);
    }
    return resolved;
  }
}

function normalizeAllowedPaths(cwd: string, allowedPaths?: readonly string[]) {
  return (allowedPaths?.length ? allowedPaths : [cwd]).map((item) =>
    path.resolve(cwd, item),
  );
}
