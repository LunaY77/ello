/**
 * 产品 Agent 的本地执行环境统一实现文件系统、shell、动态权限路径和资源生命周期。
 *
 * 静态本地环境与产品运行环境共享同一套规范路径校验和 I/O adapter；产品运行时通过 reader
 * 动态读取 permission、Thread 临时授权和 Skill 只读根，审批后无需重建 Agent。
 */
import { exec } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { CodingAgentConfig } from '../config/index.js';
import { isPathInside, resolveAbsolute } from '../tool/index.js';

import type {
  AgentEnvironment,
  AgentFileSystem,
  AgentResource,
  AgentResourceFactory,
  AgentResourceRegistry,
  AgentShell,
} from './engine/contracts.js';

const execAsync = promisify(exec);

export interface CreateLocalEnvironmentOptions {
  readonly cwd: string;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly shellExecutable?: string;
}

type PolicyFileSystem = AgentFileSystem & {
  resolvePath(targetPath: string): string;
  stat(targetPath: string): ReturnType<typeof stat>;
};

interface EnvironmentPaths {
  /**
   * 读取 产品 Agent `environment` 模块 的 `read` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   *
   * Throws:
   * - 当 产品 Agent `environment` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  read(): ReadonlyArray<string>;
  /**
   * 按 产品 Agent `environment` 模块 的一致性约束执行 `write` 状态变更。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   *
   * Throws:
   * - 当 产品 Agent `environment` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  write(): ReadonlyArray<string>;
}

/**
 * 创建使用静态路径白名单的本地 Agent 环境。
 *
 * Args:
 * - `options`: 指定规范工作目录、非空允许路径和可选 shell executable；路径在创建时冻结。
 *
 * Returns:
 * - 返回拥有文件系统、shell 和资源注册表的环境；调用方负责执行 `close()`。
 *
 * Throws:
 * - 当允许路径为空或路径无法规范化时直接抛错。
 */
export function createLocalEnvironment(
  options: CreateLocalEnvironmentOptions,
): AgentEnvironment {
  if (options.allowedPaths.length === 0) {
    throw new Error(
      'Local Agent environment requires at least one allowed path.',
    );
  }
  const cwd = canonicalTarget(path.resolve(options.cwd));
  const allowedPaths = uniqueCanonicalPaths(
    options.allowedPaths.map((allowedPath) =>
      resolveAbsolute(cwd, allowedPath),
    ),
  );
  return createEnvironment({
    cwd,
    paths: {
      read: () => allowedPaths,
      write: () => allowedPaths,
    },
    includeInstructions: true,
    ...(options.shellExecutable === undefined
      ? {}
      : { shellExecutable: options.shellExecutable }),
  });
}

/**
 * 创建读取动态 permission 状态的产品运行环境。
 *
 * Args:
 * - `config`: 当前运行已验证的配置；其中 `cwd` 是所有相对路径的唯一基准。
 * - `rules`: 每次 I/O 前读取当前 permission rules，确保 session 级授权立即生效。
 * - `threadExternalPaths`: 每次 I/O 前读取 Thread 持有的临时外部路径。
 * - `skillReadRoots`: 每次读操作前读取 Skill 内容根；这些路径不进入写权限集合。
 *
 * Returns:
 * - 返回与单次 BuiltAgent 生命周期一致的环境。
 */
export function createRuntimeEnvironment(
  config: CodingAgentConfig,
  rules: () => ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: string;
  }>,
  threadExternalPaths: () => ReadonlyArray<string>,
  skillReadRoots: () => ReadonlyArray<string>,
): AgentEnvironment {
  const cwd = canonicalTarget(path.resolve(config.cwd));
  const writePaths = () =>
    runtimeAllowedPaths(cwd, rules(), threadExternalPaths());
  return createEnvironment({
    cwd,
    paths: {
      write: writePaths,
      read: () => uniqueCanonicalPaths([...writePaths(), ...skillReadRoots()]),
    },
    includeInstructions: false,
  });
}

function createEnvironment(options: {
  readonly cwd: string;
  readonly paths: EnvironmentPaths;
  readonly includeInstructions: boolean;
  readonly shellExecutable?: string;
}): AgentEnvironment {
  const fileSystem = createPolicyFileSystem(
    options.cwd,
    options.paths.read,
    options.paths.write,
  );
  const shell = createPolicyShell(
    options.cwd,
    options.paths.write,
    options.shellExecutable,
  );
  const resources = new DefaultAgentResourceRegistry();
  const environment: AgentEnvironment = {
    fileSystem,
    shell,
    resources,
    async setup() {
      resources.bind(environment);
      await resources.setupAll();
    },
    getInstructions: options.includeInstructions
      ? async () => {
          const sections = [
            await fileSystem.getContextInstructions?.(),
            await shell.getContextInstructions?.(),
            await resources.getContextInstructions?.(),
          ].filter(
            (section): section is string =>
              typeof section === 'string' && section.length > 0,
          );
          return sections.length === 0
            ? null
            : `<environment-context>\n${sections.join('\n\n')}\n</environment-context>`;
        }
      : () => null,
    close: () => resources.closeAll(),
  };
  resources.bind(environment);
  return environment;
}

export class DefaultAgentResourceRegistry implements AgentResourceRegistry {
  private readonly resources = new Map<string, AgentResource>();
  private readonly factories = new Map<string, AgentResourceFactory>();
  private environment: AgentEnvironment | undefined;

  /**
   * 绑定资源所属环境。
   *
   * Args:
   * - `environment`: 工厂创建资源时接收的同一环境对象。
   *
   * Returns:
   * - 完成内部引用更新，不创建资源。
   */
  bind(environment: AgentEnvironment): void {
    this.environment = environment;
  }

  /**
   * 注册已构造资源。
   *
   * Args:
   * - `key`: 当前 registry 内唯一的资源标识。
   * - `resource`: 由 registry 负责后续 setup 和 close 的资源。
   *
   * Returns:
   * - 完成资源登记。
   */
  register(key: string, resource: AgentResource): void {
    if (this.resources.has(key) || this.factories.has(key)) {
      throw new Error(`Agent resource key is already registered: ${key}`);
    }
    this.resources.set(key, resource);
  }

  /**
   * 注册延迟资源工厂。
   *
   * Args:
   * - `key`: 当前 registry 内唯一的资源标识。
   * - `factory`: 首次读取时构造资源的函数。
   *
   * Returns:
   * - 完成工厂登记。
   */
  registerFactory(key: string, factory: AgentResourceFactory): void {
    if (this.resources.has(key) || this.factories.has(key)) {
      throw new Error(`Agent resource key is already registered: ${key}`);
    }
    this.factories.set(key, factory);
  }

  /**
   * 初始化全部已构造资源。
   *
   * Args:
   * - 无；资源来自当前 registry。
   *
   * Returns:
   * - Promise 在所有 setup 按注册顺序完成后 resolve。
   */
  async setupAll(): Promise<void> {
    for (const resource of this.resources.values()) {
      await resource.setup?.();
    }
  }

  /**
   * 读取已构造资源。
   *
   * Args:
   * - `key`: 要读取的资源标识。
   *
   * Returns:
   * - 返回资源；尚未构造或未注册时返回 `undefined`。
   */
  get(key: string): AgentResource | undefined {
    return this.resources.get(key);
  }

  /**
   * 读取或创建资源。
   *
   * Args:
   * - `key`: 要读取的资源标识。
   *
   * Returns:
   * - 返回已经 setup 的唯一资源实例。
   *
   * Throws:
   * - 当 key 未注册或 registry 尚未绑定环境时直接抛错。
   */
  async getOrCreate(key: string): Promise<AgentResource> {
    const existing = this.resources.get(key);
    if (existing !== undefined) return existing;
    const factory = this.factories.get(key);
    if (factory === undefined) {
      throw new Error(`No Agent resource registered for key: ${key}`);
    }
    const environment = this.environment;
    if (environment === undefined) {
      throw new Error(
        'Agent resource registry is not bound to an environment.',
      );
    }
    const resource = await factory(environment);
    await resource.setup?.();
    this.factories.delete(key);
    this.resources.set(key, resource);
    return resource;
  }

  /**
   * 列出全部资源标识。
   *
   * Args:
   * - 无；结果来自当前 registry。
   *
   * Returns:
   * - 返回已构造资源与工厂 key 的去重快照。
   */
  keys(): Array<string> {
    return [...new Set([...this.resources.keys(), ...this.factories.keys()])];
  }

  /**
   * 收集资源提供的 system context。
   *
   * Args:
   * - 无；只读取已经构造的资源。
   *
   * Returns:
   * - Promise resolve 为 `<resources>` 片段；没有内容时为 `null`。
   */
  async getContextInstructions(): Promise<string | null> {
    const sections: Array<string> = [];
    for (const [key, resource] of this.resources) {
      const instructions = await resource.getContextInstructions?.();
      if (typeof instructions === 'string' && instructions.length > 0) {
        sections.push(`<resource name="${key}">\n${instructions}\n</resource>`);
      }
    }
    return sections.length === 0
      ? null
      : `<resources>\n${sections.join('\n')}\n</resources>`;
  }

  /**
   * 逆序释放全部已构造资源并清空 registry。
   *
   * Args:
   * - 无；关闭顺序与资源注册顺序相反。
   *
   * Returns:
   * - Promise 在全部资源关闭后 resolve。
   */
  async closeAll(): Promise<void> {
    for (const resource of [...this.resources.values()].reverse()) {
      await resource.close?.();
    }
    this.resources.clear();
    this.factories.clear();
  }
}

function runtimeAllowedPaths(
  cwd: string,
  rules: ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: string;
  }>,
  threadExternalPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const roots = [cwd, ...threadExternalPaths];
  for (const rule of rules) {
    if (rule.permission === 'external_directory' && rule.action === 'allow') {
      roots.push(resolveAbsolute(cwd, rule.pattern));
    }
  }
  return uniqueCanonicalPaths(roots);
}

function createPolicyFileSystem(
  cwd: string,
  readPaths: () => ReadonlyArray<string>,
  writePaths: () => ReadonlyArray<string>,
): PolicyFileSystem {
  return {
    resolvePath: (targetPath) =>
      resolveAllowedTarget(cwd, targetPath, readPaths()),
    readText: (targetPath) =>
      readFile(resolveAllowedTarget(cwd, targetPath, readPaths()), 'utf8'),
    async writeText(targetPath, content) {
      const resolved = resolveAllowedTarget(cwd, targetPath, writePaths());
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf8');
    },
    async listDir(targetPath) {
      return (
        await readdir(resolveAllowedTarget(cwd, targetPath, readPaths()))
      ).sort();
    },
    stat: (targetPath) =>
      stat(resolveAllowedTarget(cwd, targetPath, readPaths())),
    getContextInstructions: () =>
      environmentInstructions('file-system', cwd, readPaths()),
  };
}

function createPolicyShell(
  cwd: string,
  allowedPaths: () => ReadonlyArray<string>,
  shellExecutable: string | undefined,
): AgentShell {
  return {
    async run(command, options = {}) {
      const resolvedCwd = resolveAllowedTarget(
        cwd,
        options.cwd ?? cwd,
        allowedPaths(),
      );
      try {
        const result = await execAsync(command, {
          cwd: resolvedCwd,
          timeout: options.timeout,
          env:
            options.env === undefined
              ? process.env
              : { ...process.env, ...options.env },
          ...(shellExecutable === undefined ? {} : { shell: shellExecutable }),
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return shellFailureResult(error);
      }
    },
    getContextInstructions: () =>
      environmentInstructions('shell', cwd, allowedPaths(), shellExecutable),
  };
}

function shellFailureResult(error: unknown): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  if (!(error instanceof Error)) {
    throw new TypeError('Shell execution rejected with a non-Error value.', {
      cause: error,
    });
  }
  const record: object = error;
  const killed = readBooleanProperty(record, 'killed') === true;
  const code = readProperty(record, 'code');
  return {
    exitCode: killed ? -1 : typeof code === 'number' ? code : 1,
    stdout: readStringProperty(record, 'stdout') ?? '',
    stderr: killed
      ? 'timeout'
      : (readStringProperty(record, 'stderr') ?? error.message),
  };
}

function resolveAllowedTarget(
  cwd: string,
  target: string,
  allowedPaths: ReadonlyArray<string>,
): string {
  const resolved = canonicalTarget(resolveAbsolute(cwd, target));
  if (
    !allowedPaths.some((allowedPath) => isPathInside(allowedPath, resolved))
  ) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

function uniqueCanonicalPaths(
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    ...new Set(paths.map((target) => canonicalTarget(path.resolve(target)))),
  ];
}

function canonicalTarget(target: string): string {
  if (existsSync(target)) return realpathSync(target);
  let parent = path.dirname(target);
  while (!existsSync(parent) && path.dirname(parent) !== parent) {
    parent = path.dirname(parent);
  }
  if (!existsSync(parent)) {
    throw new Error(`Path has no existing ancestor: ${target}`);
  }
  return path.join(realpathSync(parent), path.relative(parent, target));
}

function environmentInstructions(
  kind: 'file-system' | 'shell',
  cwd: string,
  allowedPaths: ReadonlyArray<string>,
  executable?: string,
): string {
  return [
    `<${kind}>`,
    `  <working-directory>${cwd}</working-directory>`,
    ...allowedPaths.map(
      (allowedPath) => `  <allowed-path>${allowedPath}</allowed-path>`,
    ),
    ...(executable === undefined
      ? []
      : [`  <executable>${executable}</executable>`]),
    `</${kind}>`,
  ].join('\n');
}

function readProperty(value: object, key: string): unknown {
  return key in value ? Reflect.get(value, key) : undefined;
}

function readStringProperty(value: object, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === 'string' ? property : undefined;
}

function readBooleanProperty(value: object, key: string): boolean | undefined {
  const property = readProperty(value, key);
  return typeof property === 'boolean' ? property : undefined;
}
