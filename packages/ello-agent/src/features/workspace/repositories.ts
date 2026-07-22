/**
 * RepoStore 负责登记和维护 Workspace 使用的 Git repository registry 与 bare mirror。
 *
 * `key` 是用户在命令中使用的仓库名称，例如 `ello`，重命名只改变这个名称。
 * `id` 是系统生成的唯一编号，只用于内部识别仓库；mirror 目录使用这个编号命名，
 * 所以改名不会移动目录，也不会影响已有 Workspace。mirror 是 Workspace 的共同
 * 仓库来源，但用户不会直接在 mirror 中编辑文件，WorkspaceStore 会从 mirror
 * 创建各自的工作目录。
 *
 * Git 用 ref 名称指向一个提交。mirror 中的 ref 分为三类：
 * - `refs/remotes/origin/*`：远端分支在本机的记录，只由远端同步更新。
 * - `refs/heads/__repostore/default`：隐藏的 Workspace 起点，每次同步远端后更新。
 * - 其它 `refs/heads/*`：用户工作分支，禁止使用 `__repostore/*` 名称。
 *
 * 添加远端仓库时：创建 bare mirror，添加普通 origin，把远端分支和标签下载到
 * `refs/remotes/origin/*`，读取远端默认分支对应的提交，并将该提交设为 Workspace
 * 起点，最后写入 SQLite。`syncOrigin` 用于首次导入和后续 fetch：它更新远端分支
 * 记录、远端默认分支指针、Workspace 起点和 `defaultBranch`，不修改用户分支。
 * 远端默认分支名称变化时，只更新 Workspace 起点，不重置同名用户分支。
 *
 * 本地导入复制分支和标签，并将来源当前提交设为 Workspace 起点；`createManaged`
 * 将新仓库的初始提交直接设为 Workspace 起点；`fetchLocal` 不导入来源仓库记录的
 * 远端分支。`remoteAdd` 接入并同步远端，失败时移除临时 remote；`remoteSet`、
 * `remoteRemove` 只维护远端连接；`rename` 只修改 key；export/import 负责 URL 和
 * bundle 的可移植性。用户分支、worktree、归档和恢复由 WorkspaceStore 管理。
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { errnoCode } from '../../infra/filesystem.js';
import { CommandError, git, gitWithInput } from '../../infra/git.js';
import {
  globalHomeDir,
  parseYamlConfig,
  stringifyYamlConfig,
} from '../config/index.js';

import type { RepositoryStore } from './repository-store.js';
import {
  RepoExportDocumentSchema,
  validateRepoKey,
  type RepoExportDocument,
  type Repository,
} from './repository.js';

export const REPOSITORY_BASELINE_REF =
  'refs/heads/__repostore/default' as const;
const RESERVED_REPOSITORY_BRANCH_PREFIX = '__repostore/';

export interface FetchResult {
  readonly key: string;
  readonly status: 'fetched' | 'no_remote';
}

/** Repository 产品生命周期服务。 */
export class RepoStore {
  /**
   * 创建 `RepoStore`，由该实例独占 Repository registry 与 mirror 操作的资源生命周期。
   *
   * Args:
   * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   */
  constructor(private readonly repository: RepositoryStore) {}

  /**
   * 读取 Repository `catalog` 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  list(): readonly Repository[] {
    return this.repository.list();
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `show` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  show(key: string): Repository | null {
    return this.repository.find(validateRepoKey(key));
  }

  /**
   * 按 Repository `catalog` 模块 的一致性约束执行 `add` 状态变更。
   *
   * Args:
   * - `sourceInput`: `add` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `keyInput`: `add` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async add(sourceInput: string, keyInput?: string): Promise<Repository> {
    const source = expandPath(sourceInput);
    const local = await isLocalPath(source);
    const key = validateRepoKey(keyInput ?? inferKey(sourceInput));
    this.assertKeyAvailable(key);
    return local
      ? this.importLocal(source, key)
      : this.importRemote(sourceInput, key);
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `fetch` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `keys`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   * - `all`: `fetch` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async fetch(
    keys: readonly string[],
    all = false,
  ): Promise<readonly FetchResult[]> {
    const hasKeys = keys.length > 0;
    if (all === hasKeys) {
      throw new Error('Specify repository keys or --all');
    }
    const selected = all ? this.list() : keys.map((key) => this.require(key));
    const results: FetchResult[] = [];
    for (const repo of selected) {
      if (repo.remoteUrl === null) {
        if (!all) throw new Error(`Repository has no remote: ${repo.key}`);
        results.push({ key: repo.key, status: 'no_remote' });
        continue;
      }
      const defaultBranch = await syncOrigin(repo.mirrorPath);
      this.repository.update({
        ...repo,
        defaultBranch,
        updatedAt: new Date().toISOString(),
      });
      results.push({ key: repo.key, status: 'fetched' });
    }
    return results;
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `fetchLocal` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   * - `sourceInput`: `fetchLocal` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async fetchLocal(key: string, sourceInput: string): Promise<Repository> {
    const repo = this.require(key);
    const source = expandPath(sourceInput);
    await assertGitRepositoryWithCommit(source);
    await assertNoReservedBranches(source);
    const defaultBranch = await detectDefaultBranch(source);
    await git(
      [
        'fetch',
        source,
        '+refs/heads/*:refs/heads/*',
        '+refs/tags/*:refs/tags/*',
      ],
      repo.mirrorPath,
    );
    await updateBaseline(repo.mirrorPath, `refs/heads/${defaultBranch}`);
    const next = {
      ...repo,
      defaultBranch,
      updatedAt: new Date().toISOString(),
    };
    return this.repository.update(next);
  }

  /**
   * 按 Repository `catalog` 模块 的一致性约束执行 `remove` 状态变更。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 Repository `catalog` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async remove(key: string): Promise<void> {
    const repo = this.require(key);
    this.repository.remove(repo);
    await rm(repo.mirrorPath, { recursive: true });
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `rename` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   * - `newKey`: `rename` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `rename` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  rename(key: string, newKey: string): Repository {
    const repo = this.require(key);
    const normalized = validateRepoKey(newKey);
    this.assertKeyAvailable(normalized);
    return this.repository.update({
      ...repo,
      key: normalized,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `remoteShow` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  remoteShow(key: string): {
    readonly key: string;
    readonly remoteUrl: string | null;
  } {
    const repo = this.require(key);
    return { key: repo.key, remoteUrl: repo.remoteUrl };
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `remoteAdd` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   * - `url`: 已由调用方提供的远端地址；网络或协议错误原样向上抛出。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async remoteAdd(key: string, url: string): Promise<Repository> {
    const repo = this.require(key);
    if (repo.remoteUrl !== null) {
      throw new Error(`Repository already has a remote: ${repo.key}`);
    }
    try {
      await git(['remote', 'add', 'origin', url], repo.mirrorPath);
      await configureOrigin(repo.mirrorPath);
      const defaultBranch = await syncOrigin(repo.mirrorPath);
      return this.repository.update({
        ...repo,
        remoteUrl: url,
        defaultBranch,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      try {
        await git(['remote', 'remove', 'origin'], repo.mirrorPath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Repository remote setup and rollback both failed: ${repo.key}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `remoteSet` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   * - `url`: 已由调用方提供的远端地址；网络或协议错误原样向上抛出。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async remoteSet(key: string, url: string): Promise<Repository> {
    const repo = this.require(key);
    if (repo.remoteUrl === null) {
      throw new Error(`Repository has no remote: ${repo.key}`);
    }
    await git(['remote', 'set-url', 'origin', url], repo.mirrorPath);
    return this.repository.update({
      ...repo,
      remoteUrl: url,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `remoteRemove` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async remoteRemove(key: string): Promise<Repository> {
    const repo = this.require(key);
    if (repo.remoteUrl === null) {
      throw new Error(`Repository has no remote: ${repo.key}`);
    }
    await git(['remote', 'remove', 'origin'], repo.mirrorPath);
    return this.repository.update({
      ...repo,
      remoteUrl: null,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 构造 Repository `catalog` 模块 中的 `createManaged` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `keyInput`: `createManaged` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `defaultBranch`: `createManaged` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   * - `identityCwd`: `createManaged` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Repository `catalog` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async createManaged(
    keyInput: string,
    defaultBranch = 'main',
    identityCwd = process.cwd(),
  ): Promise<Repository> {
    const key = validateRepoKey(keyInput);
    assertRepositoryUserBranch(defaultBranch);
    this.assertKeyAvailable(key);
    const { name, email } = await readGitIdentity(identityCwd);
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await mkdir(path.dirname(mirrorPath), { recursive: true });
    try {
      await git(['init', '--bare', mirrorPath]);
      await git(['config', 'user.name', name], mirrorPath);
      await git(['config', 'user.email', email], mirrorPath);
      const emptyTree = await gitWithInput(
        ['hash-object', '-t', 'tree', '--stdin'],
        '',
        mirrorPath,
      );
      const commit = await git(
        ['commit-tree', emptyTree, '-m', 'Initial commit'],
        mirrorPath,
      );
      await git(['update-ref', REPOSITORY_BASELINE_REF, commit], mirrorPath);
      await git(['symbolic-ref', 'HEAD', REPOSITORY_BASELINE_REF], mirrorPath);
      const now = new Date().toISOString();
      return this.repository.insert({
        id,
        key,
        mirrorPath,
        remoteUrl: null,
        defaultBranch,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      return cleanupFailedMirror(mirrorPath, error);
    }
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `export` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `keys`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   * - `outputDir`: `export` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async export(
    keys: readonly string[],
    outputDir: string,
  ): Promise<RepoExportDocument> {
    const selected =
      keys.length === 0 ? this.list() : keys.map((key) => this.require(key));
    await access(outputDir).then(
      () => {
        throw new Error(`Export destination already exists: ${outputDir}`);
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    for (const repo of selected) {
      if (repo.remoteUrl !== null && containsCredentials(repo.remoteUrl)) {
        throw new Error(`Remote URL contains credentials: ${repo.key}`);
      }
    }
    await mkdir(path.join(outputDir, 'bundles'), { recursive: true });
    const entries: RepoExportDocument['repositories'][number][] = [];
    for (const repo of selected) {
      if (repo.remoteUrl === null) {
        const bundle = `bundles/${repo.key}.bundle`;
        await mkdir(path.dirname(path.join(outputDir, bundle)), {
          recursive: true,
        });
        await git(
          ['bundle', 'create', path.join(outputDir, bundle), '--all'],
          repo.mirrorPath,
        );
        entries.push({
          key: repo.key,
          remoteUrl: null,
          defaultBranch: repo.defaultBranch,
          bundle,
        });
      } else {
        entries.push({
          key: repo.key,
          remoteUrl: repo.remoteUrl,
          defaultBranch: repo.defaultBranch,
        });
      }
    }
    const document: RepoExportDocument = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      repositories: entries,
    };
    await writeFile(
      path.join(outputDir, 'repos.yaml'),
      stringifyYamlConfig(document),
      'utf8',
    );
    return document;
  }

  /**
   * 执行 Repository `catalog` 模块 定义的 `import` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `inputDir`: `import` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Repository `catalog` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async import(inputDir: string): Promise<readonly Repository[]> {
    const document = RepoExportDocumentSchema.parse(
      parseYamlConfig(
        await readFile(path.join(inputDir, 'repos.yaml'), 'utf8'),
      ),
    );
    const keys = new Set<string>();
    for (const entry of document.repositories) {
      validateRepoKey(entry.key);
      if (keys.has(entry.key)) {
        throw new Error(`Duplicate repository key in import: ${entry.key}`);
      }
      keys.add(entry.key);
      this.assertKeyAvailable(entry.key);
      if ((entry.remoteUrl === null) !== (entry.bundle !== undefined)) {
        throw new Error(`Invalid portable repository entry: ${entry.key}`);
      }
      if (entry.bundle !== undefined) {
        resolveBundlePath(inputDir, entry.bundle);
      }
    }
    const imported: Repository[] = [];
    try {
      for (const entry of document.repositories) {
        let repo: Repository;
        if (entry.remoteUrl === null) {
          if (entry.bundle === undefined) {
            throw new Error(
              `Local repository import requires a bundle: ${entry.key}`,
            );
          }
          repo = await this.importBundle(
            resolveBundlePath(inputDir, entry.bundle),
            entry.key,
            entry.defaultBranch,
          );
        } else {
          repo = await this.importRemote(
            entry.remoteUrl,
            entry.key,
            entry.defaultBranch,
          );
        }
        imported.push(repo);
      }
      return imported;
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      for (const repository of imported.toReversed()) {
        try {
          await this.remove(repository.key);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          'Repository import failed and rollback was incomplete.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async importLocal(source: string, key: string): Promise<Repository> {
    await assertGitRepositoryWithCommit(source);
    await assertNoReservedBranches(source);
    const defaultBranch = await detectDefaultBranch(source);
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await mkdir(path.dirname(mirrorPath), { recursive: true });
    try {
      await git(['clone', '--mirror', source, mirrorPath]);
      await git(['remote', 'remove', 'origin'], mirrorPath);
      await updateBaseline(mirrorPath, `refs/heads/${defaultBranch}`);
      return this.insertImported(id, key, mirrorPath, null, defaultBranch);
    } catch (error) {
      return cleanupFailedMirror(mirrorPath, error);
    }
  }

  private async importRemote(
    url: string,
    key: string,
    expectedDefaultBranch?: string,
  ): Promise<Repository> {
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await mkdir(path.dirname(mirrorPath), { recursive: true });
    try {
      await git(['init', '--bare', mirrorPath]);
      await git(['remote', 'add', 'origin', url], mirrorPath);
      await configureOrigin(mirrorPath);
      const defaultBranch = await syncOrigin(mirrorPath);
      if (
        expectedDefaultBranch !== undefined &&
        defaultBranch !== expectedDefaultBranch
      ) {
        throw new Error(
          `Default branch mismatch for ${key}: expected ${expectedDefaultBranch}, found ${defaultBranch}`,
        );
      }
      const now = new Date().toISOString();
      return this.repository.insert({
        id,
        key,
        mirrorPath,
        remoteUrl: url,
        defaultBranch,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      return cleanupFailedMirror(mirrorPath, error);
    }
  }

  private async importBundle(
    bundlePath: string,
    key: string,
    expectedDefaultBranch: string,
  ): Promise<Repository> {
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await access(bundlePath);
    await mkdir(path.dirname(mirrorPath), { recursive: true });
    try {
      await git(['clone', '--mirror', bundlePath, mirrorPath]);
      await git(['remote', 'remove', 'origin'], mirrorPath);
      await updateBaseline(mirrorPath, REPOSITORY_BASELINE_REF);
      return this.insertImported(
        id,
        key,
        mirrorPath,
        null,
        expectedDefaultBranch,
      );
    } catch (error) {
      return cleanupFailedMirror(mirrorPath, error);
    }
  }

  private async insertImported(
    id: string,
    key: string,
    mirrorPath: string,
    remoteUrl: string | null,
    defaultBranch: string,
  ): Promise<Repository> {
    const now = new Date().toISOString();
    return this.repository.insert({
      id,
      key,
      mirrorPath,
      remoteUrl,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
    });
  }

  private require(key: string): Repository {
    const normalized = validateRepoKey(key);
    const repo = this.repository.find(normalized);
    if (repo === null) throw new Error(`Unknown repo: ${normalized}`);
    return repo;
  }

  private assertKeyAvailable(key: string): void {
    if (this.repository.find(key) !== null) {
      throw new Error(`Repo already exists: ${key}`);
    }
  }
}

function repositoryMirrorPath(repositoryId: string): string {
  return path.join(globalHomeDir(), 'mirrors', repositoryId);
}

async function cleanupFailedMirror(
  mirrorPath: string,
  originalError: unknown,
): Promise<never> {
  try {
    await rm(mirrorPath, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      `Repository setup failed and mirror cleanup was incomplete: ${mirrorPath}`,
      { cause: cleanupError },
    );
  }
  throw originalError;
}

async function configureOrigin(mirrorPath: string): Promise<void> {
  await git(
    [
      'config',
      '--replace-all',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ],
    mirrorPath,
  );
}

/** 同步远端命名空间，并重建系统管理的默认分支基线。 */
async function syncOrigin(mirrorPath: string): Promise<string> {
  await git(
    ['fetch', '--prune', '--prune-tags', '--tags', 'origin'],
    mirrorPath,
  );
  const defaultBranch = await detectRemoteDefaultBranch(mirrorPath);
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  await updateBaseline(mirrorPath, remoteRef);
  await git(
    ['symbolic-ref', 'refs/remotes/origin/HEAD', remoteRef],
    mirrorPath,
  );
  return defaultBranch;
}

async function updateBaseline(
  mirrorPath: string,
  sourceRef: string,
): Promise<void> {
  const commit = await git(
    ['rev-parse', '--verify', `${sourceRef}^{commit}`],
    mirrorPath,
  );
  await git(['update-ref', REPOSITORY_BASELINE_REF, commit], mirrorPath);
  await git(['symbolic-ref', 'HEAD', REPOSITORY_BASELINE_REF], mirrorPath);
}

/**
 * 校验 Repository `catalog` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `branch`: `assertRepositoryUserBranch` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Repository `catalog` 模块 的同步状态变更完成后返回，不产生业务结果。
 *
 * Throws:
 * - 当 Repository `catalog` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function assertRepositoryUserBranch(branch: string): void {
  if (
    branch === RESERVED_REPOSITORY_BRANCH_PREFIX.slice(0, -1) ||
    branch.startsWith(RESERVED_REPOSITORY_BRANCH_PREFIX)
  ) {
    throw new Error(`Reserved repository branch: ${branch}`);
  }
}

async function assertNoReservedBranches(repositoryPath: string): Promise<void> {
  const refs = await git(
    ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'],
    repositoryPath,
  );
  const branch = refs
    .split(/\r?\n/u)
    .find(
      (candidate) =>
        candidate !== '' &&
        (candidate === RESERVED_REPOSITORY_BRANCH_PREFIX.slice(0, -1) ||
          candidate.startsWith(RESERVED_REPOSITORY_BRANCH_PREFIX)),
    );
  if (branch !== undefined) {
    throw new Error(`Reserved repository branch: ${branch}`);
  }
}

async function detectRemoteDefaultBranch(mirrorPath: string): Promise<string> {
  const output = await git(
    ['ls-remote', '--symref', 'origin', 'HEAD'],
    mirrorPath,
  );
  const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu.exec(output);
  if (match?.[1] === undefined) {
    throw new Error('Cannot detect remote default branch');
  }
  return match[1];
}

async function assertGitRepositoryWithCommit(source: string): Promise<void> {
  await git(['rev-parse', '--git-dir'], source);
  try {
    await git(['rev-parse', '--verify', 'HEAD^{commit}'], source);
  } catch (error) {
    if (error instanceof CommandError) {
      throw new Error(`Repository has no commits: ${source}`, { cause: error });
    }
    throw error;
  }
}

async function detectDefaultBranch(mirrorPath: string): Promise<string> {
  const branch = await git(['symbolic-ref', '--short', 'HEAD'], mirrorPath);
  await git(['rev-parse', '--verify', `${branch}^{commit}`], mirrorPath);
  return branch.replace(/^refs\/heads\//u, '');
}

async function isLocalPath(source: string): Promise<boolean> {
  try {
    return (await stat(source)).isDirectory();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function expandPath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

function inferKey(source: string): string {
  const normalized = source.replace(/[\\/]$/u, '');
  const basename = normalized
    .split(/[\\/:]/u)
    .at(-1)
    ?.replace(/\.git$/u, '');
  if (basename === undefined || basename === '') {
    throw new Error(`Cannot infer repository key from source: ${source}`);
  }
  return basename;
}

function containsCredentials(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@]+@/iu.test(url);
}

async function readGitIdentity(cwd: string): Promise<{
  readonly name: string;
  readonly email: string;
}> {
  try {
    return {
      name: await git(['config', '--get', 'user.name'], cwd),
      email: await git(['config', '--get', 'user.email'], cwd),
    };
  } catch (error) {
    if (error instanceof CommandError) {
      throw new Error('Git user.name and user.email are required', {
        cause: error,
      });
    }
    throw error;
  }
}

function resolveBundlePath(inputDir: string, bundle: string): string {
  const root = path.resolve(inputDir);
  const resolved = path.resolve(root, bundle);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Repository bundle escapes import directory: ${bundle}`);
  }
  return resolved;
}
