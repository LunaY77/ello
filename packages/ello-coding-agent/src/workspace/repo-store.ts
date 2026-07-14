/**
 * RepoStore 负责登记和维护可供 Workspace 使用的 Git 仓库。
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

import { z } from 'zod';

import type { RepositoryRepository } from '../storage/repositories/repository-repository.js';
import { parseYamlConfig, stringifyYamlConfig } from '../utils/yaml.js';

import { CommandError, git, gitWithInput } from './git.js';
import { repositoryMirrorPath } from './paths.js';
import { validateRepoKey } from './slug.js';
import type { RepoExportDocument, Repository } from './types.js';

const ExportDocumentSchema = z.object({
  formatVersion: z.literal(1),
  exportedAt: z.string(),
  repositories: z.array(
    z.object({
      key: z.string(),
      remoteUrl: z.string().nullable(),
      defaultBranch: z.string(),
      bundle: z.string().optional(),
    }),
  ),
});

export const REPOSITORY_BASELINE_REF =
  'refs/heads/__repostore/default' as const;
const RESERVED_REPOSITORY_BRANCH_PREFIX = '__repostore/';

export interface FetchResult {
  readonly key: string;
  readonly status: 'fetched' | 'no_remote';
}

/** Repository 产品生命周期服务。 */
export class RepoStore {
  constructor(private readonly repository: RepositoryRepository) {}

  list(): readonly Repository[] {
    return this.repository.list();
  }

  show(key: string): Repository | null {
    return this.repository.find(validateRepoKey(key));
  }

  async add(sourceInput: string, keyInput?: string): Promise<Repository> {
    const source = expandPath(sourceInput);
    const local = await isLocalPath(source);
    const key = validateRepoKey(keyInput ?? inferKey(sourceInput));
    this.assertKeyAvailable(key);
    return local
      ? this.importLocal(source, key)
      : this.importRemote(sourceInput, key);
  }

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

  async remove(key: string): Promise<void> {
    const repo = this.require(key);
    this.repository.remove(repo);
    await rm(repo.mirrorPath, { recursive: true });
  }

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

  remoteShow(key: string): {
    readonly key: string;
    readonly remoteUrl: string | null;
  } {
    const repo = this.require(key);
    return { key: repo.key, remoteUrl: repo.remoteUrl };
  }

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
      await git(['remote', 'remove', 'origin'], repo.mirrorPath).catch(
        () => {},
      );
      throw error;
    }
  }

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
    await git(['init', '--bare', mirrorPath]);
    await git(['config', 'user.name', name], mirrorPath);
    await git(['config', 'user.email', email], mirrorPath);
    const emptyTree = await gitWithInput(
      ['hash-object', '-t', 'tree', '--stdin'],
      '',
      mirrorPath,
    );
    const commit = await gitWithInput(
      ['commit-tree', emptyTree, '-m', 'Initial commit'],
      '',
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
  }

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
      stringifyYamlConfig(document as unknown as Record<string, unknown>),
      'utf8',
    );
    return document;
  }

  async import(inputDir: string): Promise<readonly Repository[]> {
    const document = ExportDocumentSchema.parse(
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
    for (const entry of document.repositories) {
      const repo =
        entry.remoteUrl === null
          ? await this.importBundle(
              resolveBundlePath(inputDir, entry.bundle!),
              entry.key,
              entry.defaultBranch,
            )
          : await this.importRemote(
              entry.remoteUrl,
              entry.key,
              entry.defaultBranch,
            );
      imported.push(repo);
    }
    return imported;
  }

  private async importLocal(source: string, key: string): Promise<Repository> {
    await assertGitRepositoryWithCommit(source);
    await assertNoReservedBranches(source);
    const defaultBranch = await detectDefaultBranch(source);
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await mkdir(path.dirname(mirrorPath), { recursive: true });
    await git(['clone', '--mirror', source, mirrorPath]);
    await git(['remote', 'remove', 'origin'], mirrorPath);
    await updateBaseline(mirrorPath, `refs/heads/${defaultBranch}`);
    return this.insertImported(id, key, mirrorPath, null, defaultBranch);
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
      await rm(mirrorPath, { recursive: true, force: true }).catch(() => {});
      throw error;
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
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
