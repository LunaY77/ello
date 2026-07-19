/**
 * 本地 shell 环境实现。
 *
 * 提供基于本机文件系统与子进程的 {@link AgentEnvironment}：文件读写/列目录、
 * shell 命令执行，以及一个资源注册表。所有文件与 shell 操作都受「允许路径」
 * 边界约束——任何解析后落在允许目录之外的访问都会被拒绝，防止代理越出预期的
 * 工作范围。
 */

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
} from '../engine/api/types.js';

/** Promise 化的 `child_process.exec`。 */
const execAsync = promisify(exec);

/** {@link createLocalShellEnvironment} 的入参。 */
export interface CreateLocalEnvironmentOptions {
  /** 工作目录，默认取当前进程 cwd。 */
  readonly cwd?: string;
  /** 允许访问的路径白名单；缺省时退化为仅允许 `cwd`。 */
  readonly allowedPaths?: string[];
  /** 自定义 shell 可执行文件，缺省走平台默认 shell。 */
  readonly shellExecutable?: string;
}

/**
 * 创建一个基于本地文件系统与 shell 的代理环境。
 *
 * 装配文件系统、shell 与资源注册表，并把允许路径统一解析为绝对路径作为边界。
 * 环境的 `setup` 会绑定并初始化所有资源，`getInstructions` 汇总各组件
 * 的上下文片段，`close` 逆序释放资源。
 */
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
    shell,
    resources,
    // 初始化：把资源绑定到本环境，再依次跑各资源的 setup。
    async setup() {
      resources.bind(environment);
      await resources.setupAll();
    },
    // 汇总文件系统、shell、资源三方的上下文片段，包进 <environment-context>。
    async getInstructions() {
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
    // 关闭：释放全部资源。
    async close() {
      await resources.closeAll();
    },
  };
  // 立即绑定一次，使后续延迟创建的资源工厂也能拿到该环境引用。
  resources.bind(environment);
  return environment;
}

/** {@link createLocalShellEnvironment} 的别名，保留更短的命名。 */
export const createLocalEnvironment = createLocalShellEnvironment;

/**
 * 默认资源注册表实现。
 *
 * 维护两类登记：已实例化的资源，以及按需创建资源的工厂。支持立即注册、
 * 懒加载创建（`getOrCreate`）、统一初始化/关闭，以及汇总各资源的上下文片段。
 */
export class DefaultAgentResourceRegistry implements AgentResourceRegistry {
  /** 已实例化资源，按键索引。 */
  private readonly resources = new Map<string, AgentResource>();
  /** 资源工厂，按键索引，用于懒加载创建尚未实例化的资源。 */
  private readonly factories = new Map<string, AgentResourceFactory>();
  /** 注册表所归属的环境，懒加载工厂创建资源时作为入参传入。 */
  private environment: AgentEnvironment | undefined;

  /** 绑定注册表所属环境，供工厂创建资源时使用。 */
  bind(environment: AgentEnvironment): void {
    this.environment = environment;
  }

  /** 直接登记一个已实例化的资源。 */
  register(key: string, resource: AgentResource): void {
    this.resources.set(key, resource);
  }

  /** 登记一个资源工厂，待 `getOrCreate` 时再实例化。 */
  registerFactory(key: string, factory: AgentResourceFactory): void {
    this.factories.set(key, factory);
  }

  /** 依次初始化所有已实例化资源。 */
  async setupAll(): Promise<void> {
    for (const resource of this.resources.values()) {
      await resource.setup?.();
    }
  }

  /** 取一个已实例化资源，不存在则返回 `undefined`。 */
  get(key: string): AgentResource | undefined {
    return this.resources.get(key);
  }

  /**
   * 取资源，缺失则用对应工厂懒加载创建并初始化后缓存。
   *
   * 既无现成资源又无工厂、或注册表尚未绑定环境时抛错。
   */
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

  /** 列出全部已知键（资源与工厂去重合并）。 */
  keys(): string[] {
    return [...new Set([...this.resources.keys(), ...this.factories.keys()])];
  }

  /** 汇总各资源的上下文片段，包进带名字的 <resource> 标签内。 */
  async getContextInstructions(): Promise<string | null> {
    const sections: string[] = [];
    for (const key of this.resources.keys()) {
      const instructions = await this.resources
        .get(key)
        ?.getContextInstructions?.();
      if (instructions) {
        sections.push(`<resource name="${key}">\n${instructions}\n</resource>`);
      }
    }
    return sections.length === 0
      ? null
      : `<resources>\n${sections.join('\n')}\n</resources>`;
  }

  /** 逆序关闭所有资源（后注册者先关），并清空登记。 */
  async closeAll(): Promise<void> {
    for (const resource of [...this.resources.values()].reverse()) {
      await resource.close?.();
    }
    this.resources.clear();
    this.factories.clear();
  }
}

/**
 * 受允许路径边界约束的本地文件系统。
 *
 * 所有读/写/列目录操作都先经 {@link resolveAllowedPath} 解析并校验边界，
 * 任何越界访问都会抛错，确保代理只能触碰被显式允许的目录。
 */
class LocalFileSystem implements AgentFileSystem {
  constructor(
    private readonly options: {
      readonly cwd: string;
      readonly allowedPaths: readonly string[];
    },
  ) {}

  /** 读取文本文件内容（UTF-8），路径受允许边界约束。 */
  readText(targetPath: string): Promise<string> {
    return readFile(this.resolveAllowedPath(targetPath), 'utf8');
  }

  /** 写入文本文件，自动递归创建上级目录；路径受允许边界约束。 */
  async writeText(targetPath: string, content: string): Promise<void> {
    const resolved = this.resolveAllowedPath(targetPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf8');
  }

  /** 列出目录条目并按名排序；路径受允许边界约束。 */
  async listDir(targetPath: string): Promise<string[]> {
    return (await readdir(this.resolveAllowedPath(targetPath))).sort();
  }

  /** 产出文件系统上下文片段：工作目录与允许路径清单。 */
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

  /**
   * 将目标路径解析为绝对路径并校验是否落在某个允许目录内。
   *
   * 相对路径以 `cwd` 为基准解析。通过 `path.relative` 判断 `resolved` 是否
   * 等于某允许目录、或是其子孙（相对路径不以 `..` 开头且非绝对路径）；任一
   * 允许目录命中即放行，全部落空则抛出越界错误。
   */
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

/**
 * 受允许路径边界约束的本地 shell。
 *
 * 通过子进程执行命令，执行目录（cwd）必须落在允许路径内。命令失败、超时或
 * 非零退出都会被归一化为带 `exitCode`/`stdout`/`stderr` 的结果而非抛错。
 */
class LocalShell implements AgentShell {
  constructor(
    private readonly options: {
      readonly cwd: string;
      readonly allowedPaths: readonly string[];
      readonly shellExecutable?: string;
    },
  ) {}

  /**
   * 在受约束的工作目录中执行一条 shell 命令。
   *
   * 成功返回 `exitCode: 0` 及标准输出/错误；异常时把超时映射为 `exitCode: -1`、
   * stderr 置为 `'timeout'`，其余按进程退出码（或回退 1）归一化，绝不抛错上抛。
   */
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
        // 默认继承当前进程环境变量；传入 env 时与之合并而非替换。
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
        exitCode: err.killed ? -1 : typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.killed ? 'timeout' : (err.stderr ?? err.message),
      };
    }
  }

  /** 产出 shell 上下文片段：工作目录、允许路径、可选自定义可执行文件。 */
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

  /**
   * 解析命令执行目录并校验其落在允许路径内。
   *
   * 未指定则用环境默认 cwd；判定逻辑同文件系统的路径边界检查，越界即抛错。
   */
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

/** 把允许路径列表统一解析为相对 `cwd` 的绝对路径；为空则退化为仅允许 `cwd`。 */
function normalizeAllowedPaths(cwd: string, allowedPaths?: readonly string[]) {
  return (allowedPaths?.length ? allowedPaths : [cwd]).map((item) =>
    path.resolve(cwd, item),
  );
}
