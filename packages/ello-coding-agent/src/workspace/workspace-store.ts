/**
 * WorkspaceStore 管理任务目录、各仓库的工作目录、任务分支、归档和恢复。
 * Git 提交和分支保存在 RepoStore 管理的 bare mirror 中；Workspace 保存任务目录、
 * 工作目录位置和生命周期状态。
 *
 * 创建 `feature/name` 或 `fix/name` 时：校验 selector 和 repo key，从 SQLite 找到
 * Repository，确认每个仓库都有 Workspace 起点，创建 `repos/docs/tmp` 目录，
 * 从 Workspace 起点创建或复用同名分支，为每个仓库挂载工作目录，清除隐式 upstream，
 * 最后写入 Workspace 和各 checkout 的结构化记录。
 *
 * 跨仓库任务使用同名的 `feature/name` 或 `fix/name` 分支，分支默认不绑定 upstream，
 * 远端发布由用户显式执行，系统不创建远端分支。`explore/name` 从 Workspace 起点
 * 挂载 detached 工作目录，不占用任务分支。
 *
 * `addRepos` 和 `removeRepos` 修改任务中的仓库集合；`rename` 移动任务目录并修复
 * worktree 连接；`archive` 保存完整任务现场、释放工作分支并允许同名任务创建新代；
 * `repair` 根据 SQLite 和 mirror 状态恢复缺失目录及 checkout；`delete` 清理任务
 * 的 tmux、worktree、目录和记录。遇到 dirty 文件、非 Git 占位目录或不安全冲突时失败。
 * RepoStore 提供仓库和 Workspace 起点，WorkspaceRepository 提供任务记录，TmuxStore
 * 管理终端会话；WorkspaceStore 负责协调三者。
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceRepository } from '../storage/repositories/workspace-repository.js';

import { CommandError, git } from './git.js';
import {
  activeWorkspacesDir,
  archivedWorkspaceDir,
  archivedWorkspacesDir,
  workspaceDir,
} from './paths.js';
import { planWorkspaceCreate, planWorkspaceRepo } from './plan.js';
import {
  assertRepositoryUserBranch,
  REPOSITORY_BASELINE_REF,
  RepoStore,
} from './repo-store.js';
import { slugify, validateKind, validateRepoKey } from './slug.js';
import { TmuxStore } from './tmux.js';
import type {
  Repository,
  Workspace,
  WorkspaceRepo,
  WorkspaceStatus,
} from './types.js';

export interface WorkspaceStatusView {
  readonly workspace: Workspace;
  readonly missingRoot: boolean;
  readonly repos: readonly {
    readonly key: string;
    readonly path: string;
    readonly missing: boolean;
    readonly dirty: boolean;
    readonly gitStatus: string;
    readonly error: string | null;
  }[];
}

export interface WorkspaceRepairResult {
  readonly workspace: Workspace;
  readonly actions: readonly string[];
  readonly status: WorkspaceStatusView;
}

/** Workspace 产品生命周期服务。 */
export class WorkspaceStore {
  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly repos: RepoStore,
    private readonly mount: string,
    private readonly tmux = new TmuxStore(),
  ) {}

  async initializeMount(): Promise<void> {
    await mkdir(activeWorkspacesDir(this.mount), { recursive: true });
    await mkdir(archivedWorkspacesDir(this.mount), { recursive: true });
  }

  async create(
    kindInput: string,
    nameInput: string,
    repoKeys: readonly string[],
    tmuxSession?: string,
  ): Promise<Workspace> {
    const kind = validateKind(kindInput);
    const name = slugify(nameInput);
    const plan = planWorkspaceCreate({
      kind,
      name,
      rootPath: workspaceDir(this.mount, kind, name),
      repoKeys,
    });
    const existing = this.repository.findActive(kind, name);
    if (existing !== null) {
      throw new Error(`Workspace already exists: ${kind}/${name}`);
    }
    await assertPathMissing(plan.rootPath);
    const selected = plan.repoKeys.map((key) => this.requireRepo(key));
    for (const repo of selected) {
      await assertCommit(repo, REPOSITORY_BASELINE_REF);
    }
    await this.releaseArchivedSelector(kind, name);
    if (tmuxSession !== undefined) {
      await this.tmux.assertAvailable();
      await this.tmux.assertSessionAvailable(tmuxSession);
    }
    await this.initializeMount();
    await mkdir(path.join(plan.rootPath, 'repos'), { recursive: true });
    await mkdir(path.join(plan.rootPath, 'tmp'));
    await mkdir(path.join(plan.rootPath, 'docs'));
    const checkouts: WorkspaceRepo[] = [];
    for (const repo of selected) {
      checkouts.push(await this.attachRepo(plan.rootPath, repo, plan.branch));
    }
    const now = new Date().toISOString();
    let workspace: Workspace = {
      id: randomUUID(),
      kind: plan.kind,
      name: plan.name,
      rootPath: plan.rootPath,
      status: 'active',
      branch: plan.branch,
      tmuxSession: null,
      repos: checkouts,
      createdAt: now,
      updatedAt: now,
    };
    this.repository.insert(workspace);
    if (tmuxSession !== undefined) {
      await this.tmux.newSession(tmuxSession, workspace.rootPath);
      workspace = {
        ...workspace,
        tmuxSession,
        updatedAt: new Date().toISOString(),
      };
      this.repository.update(workspace);
    }
    return workspace;
  }

  list(
    filters: { readonly kind?: string; readonly status?: string } = {},
  ): readonly Workspace[] {
    return this.repository.list({
      ...(filters.kind === undefined
        ? {}
        : { kind: validateKind(filters.kind) }),
      ...(filters.status === undefined
        ? {}
        : { status: validateWorkspaceStatus(filters.status) }),
    });
  }

  listRepairable(): readonly Workspace[] {
    return [
      ...this.repository.list({ status: 'active' }),
      ...this.repository.list({ status: 'archived' }),
      ...this.repository.list({ status: 'missing' }),
    ].sort((left, right) => left.rootPath.localeCompare(right.rootPath));
  }

  listArchived(kindInput: string, nameInput: string): readonly Workspace[] {
    return this.repository.listArchived(
      validateKind(kindInput),
      slugify(nameInput),
    );
  }

  open(kindInput: string, nameInput: string): Workspace {
    const kind = validateKind(kindInput);
    const name = slugify(nameInput);
    const workspace = this.repository.find(kind, name);
    if (workspace === null || workspace.status === 'deleted') {
      throw new Error(`Unknown workspace: ${kind}/${name}`);
    }
    return workspace;
  }

  openActive(kindInput: string, nameInput: string): Workspace {
    const kind = validateKind(kindInput);
    const name = slugify(nameInput);
    const workspace = this.repository.findActive(kind, name);
    if (workspace === null || workspace.status !== 'active') {
      throw new Error(`Unknown active workspace: ${kind}/${name}`);
    }
    return workspace;
  }

  openArchived(kindInput: string, nameInput: string): Workspace {
    const kind = validateKind(kindInput);
    const name = slugify(nameInput);
    const archived = this.repository.listArchived(kind, name);
    if (archived.length === 0) {
      throw new Error(`Unknown archived workspace: ${kind}/${name}`);
    }
    if (archived.length > 1) {
      throw new Error(
        `Archived workspace selector is ambiguous: ${kind}/${name}; use workspace id`,
      );
    }
    const [workspace] = archived;
    if (workspace === undefined) {
      throw new Error(`Archived workspace lookup failed: ${kind}/${name}`);
    }
    return workspace;
  }

  openById(id: string): Workspace {
    const workspace = this.repository.findById(id);
    if (workspace === null || workspace.status === 'deleted') {
      throw new Error(`Unknown workspace id: ${id}`);
    }
    return workspace;
  }

  fromCwd(cwd: string): Workspace {
    const workspace = this.repository.findActiveByRoot(path.resolve(cwd));
    if (workspace === null) {
      throw new Error(
        `Current directory is not a workspace root: ${path.resolve(cwd)}`,
      );
    }
    return workspace;
  }

  async addRepos(
    workspace: Workspace,
    repoKeys: readonly string[],
  ): Promise<Workspace> {
    assertActive(workspace);
    const existing = new Set(workspace.repos.map((repo) => repo.repositoryId));
    const selected = repoKeys.map((key) => this.requireRepo(key));
    for (const repo of selected) {
      if (existing.has(repo.id)) {
        throw new Error(`Repository already belongs to workspace: ${repo.key}`);
      }
      await assertCommit(repo, REPOSITORY_BASELINE_REF);
    }
    const added: WorkspaceRepo[] = [];
    for (const repo of selected) {
      added.push(
        await this.attachRepo(workspace.rootPath, repo, workspace.branch),
      );
    }
    const next = {
      ...workspace,
      repos: [...workspace.repos, ...added],
      updatedAt: new Date().toISOString(),
    };
    return this.repository.update(next);
  }

  async createRepo(workspace: Workspace, key: string): Promise<Workspace> {
    assertActive(workspace);
    const repo = await this.repos.createManaged(
      key,
      'main',
      workspace.rootPath,
    );
    return this.addRepos(workspace, [repo.key]);
  }

  async removeRepos(
    workspace: Workspace,
    repoKeys: readonly string[],
    force: boolean,
  ): Promise<Workspace> {
    assertActive(workspace);
    const removing = new Set(repoKeys.map(validateRepoKey));
    for (const key of removing) {
      if (!workspace.repos.some((repo) => repo.key === key)) {
        throw new Error(`Repository is not in workspace: ${key}`);
      }
    }
    for (const repo of workspace.repos.filter((item) =>
      removing.has(item.key),
    )) {
      if (!force && (await isDirty(repo.path))) {
        throw new Error(`Workspace repo is dirty: ${repo.key}`);
      }
      await this.removeWorktree(repo, force);
    }
    const next = {
      ...workspace,
      repos: workspace.repos.filter((repo) => !removing.has(repo.key)),
      updatedAt: new Date().toISOString(),
    };
    return this.repository.update(next);
  }

  async bindTmux(workspace: Workspace, session: string): Promise<Workspace> {
    assertActive(workspace);
    if (workspace.tmuxSession !== null) {
      throw new Error(
        `Workspace already has a tmux session: ${workspace.tmuxSession}`,
      );
    }
    await this.tmux.assertAvailable();
    await this.tmux.assertSessionAvailable(session);
    await this.tmux.newSession(session, workspace.rootPath);
    return this.repository.update({
      ...workspace,
      tmuxSession: session,
      updatedAt: new Date().toISOString(),
    });
  }

  async rename(workspace: Workspace, newNameInput: string): Promise<Workspace> {
    assertActive(workspace);
    const newName = slugify(newNameInput);
    if (this.repository.findActive(workspace.kind, newName) !== null) {
      throw new Error(`Workspace already exists: ${workspace.kind}/${newName}`);
    }
    const target = workspaceDir(this.mount, workspace.kind, newName);
    await assertPathMissing(target);
    const nextTmux =
      workspace.tmuxSession === null ? null : `${workspace.kind}-${newName}`;
    if (workspace.tmuxSession !== null) {
      await this.tmux.assertSessionAvailable(nextTmux!);
      await this.tmux.renameSession(workspace.tmuxSession, nextTmux!);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await rename(workspace.rootPath, target);
    const repos = workspace.repos.map((repo) => ({
      ...repo,
      path: path.join(target, path.relative(workspace.rootPath, repo.path)),
    }));
    for (const repo of repos) {
      const registered = this.requireRepo(repo.key);
      await git(['worktree', 'repair', repo.path], registered.mirrorPath);
    }
    return this.repository.update({
      ...workspace,
      name: newName,
      rootPath: target,
      tmuxSession: nextTmux,
      repos,
      updatedAt: new Date().toISOString(),
    });
  }

  async archive(workspace: Workspace): Promise<Workspace> {
    assertActive(workspace);
    await this.assertClean(workspace);
    let current = await this.clearTmux(workspace);
    const now = new Date().toISOString();
    const detachedRepos: WorkspaceRepo[] = [];
    for (const repo of current.repos) {
      const headCommit = await git(['rev-parse', 'HEAD'], repo.path);
      if (repo.checkoutMode === 'branch') {
        await git(['switch', '--detach'], repo.path);
      }
      detachedRepos.push({
        ...repo,
        checkoutMode: 'detached',
        branch: null,
        headCommit,
      });
    }
    const target = archivedWorkspaceDir(
      this.mount,
      current.kind,
      current.name,
      current.id,
      now,
    );
    await assertPathMissing(target);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(current.rootPath, target);
    const repos = detachedRepos.map((repo) => ({
      ...repo,
      path: path.join(target, path.relative(current.rootPath, repo.path)),
    }));
    // archive 保留完整 checkout；移动后必须同步修复 bare mirror 记录的 worktree 路径。
    for (const repo of repos) {
      const registered = this.requireRepo(repo.key);
      await git(['worktree', 'repair', repo.path], registered.mirrorPath);
    }
    current = {
      ...current,
      rootPath: target,
      status: 'archived',
      repos,
      updatedAt: now,
    };
    return this.repository.update(current);
  }

  async delete(workspace: Workspace, force: boolean): Promise<Workspace> {
    if (workspace.status !== 'active' && workspace.status !== 'archived') {
      throw new Error(
        `Workspace cannot be deleted from status: ${workspace.status}`,
      );
    }
    if (!force) await this.assertClean(workspace);
    let current = await this.clearTmux(workspace);
    for (const repo of current.repos) await this.removeWorktree(repo, force);
    await rm(current.rootPath, { recursive: true });
    current = {
      ...current,
      status: 'deleted',
      tmuxSession: null,
      updatedAt: new Date().toISOString(),
    };
    return this.repository.update(current);
  }

  async status(
    workspaces: readonly Workspace[],
  ): Promise<readonly WorkspaceStatusView[]> {
    return Promise.all(
      workspaces.map(async (workspace) => {
        const missingRoot = !(await exists(workspace.rootPath));
        const repos = await Promise.all(
          workspace.repos.map(async (repo) => {
            const missing = !(await exists(repo.path));
            let gitStatus = '';
            let error: string | null = null;
            if (!missing) {
              try {
                gitStatus = await git(['status', '--porcelain'], repo.path);
              } catch (cause) {
                error = cause instanceof Error ? cause.message : String(cause);
              }
            }
            return {
              key: repo.key,
              path: repo.path,
              missing,
              dirty: gitStatus !== '',
              gitStatus,
              error,
            };
          }),
        );
        return { workspace, missingRoot, repos };
      }),
    );
  }

  async reconcile(workspaces: readonly Workspace[]) {
    const status = await this.status(workspaces);
    return this.repository.recordReconcile(
      status.map((view) => ({
        workspace: view.workspace,
        missingRoot: view.missingRoot,
        repos: view.repos.map((repo) => {
          const stored = requireWorkspaceRepoByKey(view.workspace, repo.key);
          return {
            repositoryId: stored.repositoryId,
            key: repo.key,
            path: repo.path,
            status: repo.missing
              ? 'missing'
              : repo.error !== null
                ? 'invalid'
                : repo.dirty
                  ? 'dirty'
                  : 'active',
            ...(repo.gitStatus === '' ? {} : { gitStatus: repo.gitStatus }),
            ...(repo.error === null ? {} : { error: repo.error }),
          };
        }),
      })),
    );
  }

  async repair(
    workspaces: readonly Workspace[],
  ): Promise<readonly WorkspaceRepairResult[]> {
    const results: WorkspaceRepairResult[] = [];
    for (const workspace of workspaces) {
      results.push(await this.repairWorkspace(workspace));
    }
    return results;
  }

  private async repairWorkspace(
    workspace: Workspace,
  ): Promise<WorkspaceRepairResult> {
    if (workspace.status === 'deleted') {
      throw new Error(
        `Deleted workspace cannot be repaired: ${workspace.kind}/${workspace.name}`,
      );
    }
    const actions: string[] = [];
    const expectedStatus = this.repairedStatus(workspace);
    const expectedRoot =
      expectedStatus === 'archived'
        ? workspace.rootPath
        : workspaceDir(this.mount, workspace.kind, workspace.name);
    const worktreeInfo = new Map(
      await Promise.all(
        workspace.repos.map(
          async (repo) =>
            [
              repo.repositoryId,
              await readWorktreeInfo(this.requireRepo(repo.key), repo.path),
            ] as const,
        ),
      ),
    );
    const expectedRepos = workspace.repos.map((repo) => ({
      ...repo,
      path: path.join(expectedRoot, 'repos', repo.key),
    }));
    const expectedReposDir = path.join(expectedRoot, 'repos');
    if (await exists(expectedReposDir)) {
      const managedKeys = new Set(expectedRepos.map((repo) => repo.key));
      const unexpected = (await readdir(expectedReposDir)).filter(
        (entry) => !managedKeys.has(entry),
      );
      if (unexpected.length > 0) {
        throw new Error(
          `Workspace has unmanaged repo directories: ${unexpected.join(', ')}`,
        );
      }
    }
    for (const repo of expectedRepos) {
      const original = requireWorkspaceRepoById(workspace, repo.repositoryId);
      if (
        (await exists(repo.path)) ||
        (original.path !== repo.path && (await exists(original.path)))
      ) {
        continue;
      }
      const registered = this.requireRepo(repo.key);
      if (repo.checkoutMode === 'branch') {
        if (repo.branch === null) {
          throw new Error(
            `Branch checkout is missing branch state: ${repo.key}`,
          );
        }
        assertRepositoryUserBranch(repo.branch);
        await assertCommit(registered, repo.branch);
      } else {
        const info = requireWorktreeInfo(worktreeInfo, repo.repositoryId);
        await assertCommit(registered, detachedHead(repo, info));
      }
    }

    if (
      workspace.rootPath !== expectedRoot &&
      (await exists(workspace.rootPath))
    ) {
      await assertPathMissing(expectedRoot);
      await mkdir(path.dirname(expectedRoot), { recursive: true });
      await rename(workspace.rootPath, expectedRoot);
      actions.push('moved_root');
    }
    if (!(await exists(expectedRoot))) {
      await mkdir(expectedRoot, { recursive: true });
      actions.push('created_root');
    }
    for (const directory of ['repos', 'tmp', 'docs'] as const) {
      const directoryPath = path.join(expectedRoot, directory);
      if (!(await exists(directoryPath))) {
        await mkdir(directoryPath);
        actions.push(`created_${directory}_directory`);
      }
    }

    for (const repo of expectedRepos) {
      const registered = this.requireRepo(repo.key);
      const info = requireWorktreeInfo(worktreeInfo, repo.repositoryId);
      const original = requireWorkspaceRepoById(workspace, repo.repositoryId);
      if (
        original.path !== repo.path &&
        (await exists(original.path)) &&
        !(await exists(repo.path))
      ) {
        await rename(original.path, repo.path);
        actions.push(`moved_checkout:${repo.key}`);
      }
      if (await exists(repo.path)) {
        if (info?.path !== repo.path) {
          await git(['worktree', 'repair', repo.path], registered.mirrorPath);
          actions.push(`repaired_worktree:${repo.key}`);
        }
        await assertManagedCheckout(repo);
        continue;
      }
      await git(['worktree', 'prune'], registered.mirrorPath);
      if (repo.checkoutMode === 'branch') {
        if (repo.branch === null) {
          throw new Error(
            `Branch checkout is missing branch state: ${repo.key}`,
          );
        }
        await assertCommit(registered, repo.branch);
        await git(
          ['worktree', 'add', repo.path, repo.branch],
          registered.mirrorPath,
        );
      } else {
        const headCommit = detachedHead(repo, info);
        await assertCommit(registered, headCommit);
        await git(
          ['worktree', 'add', '--detach', repo.path, headCommit],
          registered.mirrorPath,
        );
      }
      actions.push(`restored_checkout:${repo.key}`);
    }

    const databaseChanged =
      expectedRoot !== workspace.rootPath ||
      expectedStatus !== workspace.status ||
      expectedRepos.some(
        (repo, index) => repo.path !== workspace.repos[index]?.path,
      );
    const repaired = databaseChanged
      ? this.repository.update({
          ...workspace,
          rootPath: expectedRoot,
          status: expectedStatus,
          repos: expectedRepos,
          updatedAt: new Date().toISOString(),
        })
      : workspace;
    if (databaseChanged) {
      actions.push('updated_database');
    }
    const [status] = await this.status([repaired]);
    if (status === undefined) {
      throw new Error(`Workspace repair produced no status: ${repaired.id}`);
    }
    return {
      workspace: repaired,
      actions,
      status,
    };
  }

  private repairedStatus(workspace: Workspace): 'active' | 'archived' {
    if (workspace.status === 'active' || workspace.status === 'archived') {
      return workspace.status;
    }
    const archiveRoot = archivedWorkspacesDir(this.mount);
    return isWithin(archiveRoot, workspace.rootPath) ? 'archived' : 'active';
  }

  private async attachRepo(
    rootPath: string,
    repository: Repository,
    branch: string | null,
  ): Promise<WorkspaceRepo> {
    if (branch !== null) assertRepositoryUserBranch(branch);
    const checkout = planWorkspaceRepo(rootPath, repository, branch);
    await mkdir(path.dirname(checkout.path), { recursive: true });
    if (branch === null) {
      await git(
        ['worktree', 'add', '--detach', checkout.path, REPOSITORY_BASELINE_REF],
        repository.mirrorPath,
      );
    } else if (await refExists(repository, `refs/heads/${branch}`)) {
      await git(
        ['worktree', 'add', checkout.path, branch],
        repository.mirrorPath,
      );
    } else {
      await git(
        [
          'worktree',
          'add',
          '-b',
          branch,
          checkout.path,
          REPOSITORY_BASELINE_REF,
        ],
        repository.mirrorPath,
      );
    }
    if (branch !== null) {
      await clearBranchUpstream(checkout.path, branch);
    }
    return {
      ...checkout,
      headCommit: await git(['rev-parse', 'HEAD'], checkout.path),
    };
  }

  private async releaseArchivedSelector(
    kind: Workspace['kind'],
    name: string,
  ): Promise<void> {
    for (const workspace of this.repository.listArchived(kind, name)) {
      let changed = false;
      const repos: WorkspaceRepo[] = [];
      for (const repo of workspace.repos) {
        if (repo.checkoutMode === 'detached') {
          repos.push(repo);
          continue;
        }
        const registered = this.requireRepo(repo.key);
        let headCommit: string;
        if (await exists(repo.path)) {
          headCommit = await git(['rev-parse', 'HEAD'], repo.path);
          await git(['switch', '--detach'], repo.path);
        } else {
          await git(['worktree', 'prune'], registered.mirrorPath);
          if (repo.branch === null) {
            throw new Error(
              `Archived branch checkout is missing branch state: ${repo.key}`,
            );
          }
          assertRepositoryUserBranch(repo.branch);
          headCommit = await git(
            ['rev-parse', '--verify', `${repo.branch}^{commit}`],
            registered.mirrorPath,
          );
        }
        repos.push({
          ...repo,
          checkoutMode: 'detached',
          branch: null,
          headCommit,
        });
        changed = true;
      }
      if (changed) {
        this.repository.update({
          ...workspace,
          repos,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private requireRepo(key: string): Repository {
    const repo = this.repos.show(key);
    if (repo === null) throw new Error(`Unknown repo: ${key}`);
    return repo;
  }

  private async assertClean(workspace: Workspace): Promise<void> {
    for (const repo of workspace.repos) {
      if (await isDirty(repo.path))
        throw new Error(`Workspace repo is dirty: ${repo.key}`);
    }
  }

  private async removeWorktree(
    repo: WorkspaceRepo,
    force: boolean,
  ): Promise<void> {
    const registered = this.requireRepo(repo.key);
    await git(
      ['worktree', 'remove', repo.path, ...(force ? ['--force'] : [])],
      registered.mirrorPath,
    );
  }

  private async clearTmux(workspace: Workspace): Promise<Workspace> {
    if (workspace.tmuxSession === null) return workspace;
    await this.tmux.killSession(workspace.tmuxSession);
    const next = {
      ...workspace,
      tmuxSession: null,
      updatedAt: new Date().toISOString(),
    };
    return this.repository.update(next);
  }
}

/**
 * 清除可能由 mirror 或旧 workspace 遗留的 upstream。
 * 远端分支必须由用户在准备发布时显式 `push --set-upstream` 创建。
 */
async function clearBranchUpstream(
  checkoutPath: string,
  branch: string,
): Promise<void> {
  for (const key of [
    `branch.${branch}.remote`,
    `branch.${branch}.merge`,
    `branch.${branch}.pushRemote`,
  ]) {
    try {
      await git(['config', '--unset-all', key], checkoutPath);
    } catch (error) {
      if (!(error instanceof CommandError) || error.exitCode !== 5) {
        throw error;
      }
    }
  }
}

async function assertPathMissing(target: string): Promise<void> {
  if (await exists(target)) throw new Error(`Path already exists: ${target}`);
}

async function assertCommit(
  repository: Repository,
  ref: string,
): Promise<void> {
  await git(
    ['rev-parse', '--verify', `${ref}^{commit}`],
    repository.mirrorPath,
  );
}

async function refExists(
  repository: Repository,
  ref: string,
): Promise<boolean> {
  try {
    await git(['show-ref', '--verify', '--quiet', ref], repository.mirrorPath);
    return true;
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 1) return false;
    throw error;
  }
}

async function isDirty(repoPath: string): Promise<boolean> {
  return (await git(['status', '--porcelain'], repoPath)) !== '';
}

async function assertManagedCheckout(repo: WorkspaceRepo): Promise<void> {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], repo.path);
  if (inside !== 'true') {
    throw new Error(`Workspace repo is not a Git worktree: ${repo.key}`);
  }
  if (repo.checkoutMode === 'branch') {
    if (repo.branch === null) {
      throw new Error(`Branch checkout is missing branch state: ${repo.key}`);
    }
    assertRepositoryUserBranch(repo.branch);
    const branch = await git(['symbolic-ref', '--short', 'HEAD'], repo.path);
    if (branch !== repo.branch) {
      throw new Error(
        `Workspace repo branch mismatch: ${repo.key}, expected ${repo.branch}, found ${branch}`,
      );
    }
    return;
  }
  try {
    const branch = await git(
      ['symbolic-ref', '--short', '-q', 'HEAD'],
      repo.path,
    );
    throw new Error(
      `Workspace repo must be detached: ${repo.key}, found ${branch}`,
    );
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 1) return;
    throw error;
  }
}

async function readWorktreeInfo(
  repository: Repository,
  checkoutPath: string,
): Promise<{ readonly path: string; readonly head: string } | null> {
  const output = await git(
    ['worktree', 'list', '--porcelain'],
    repository.mirrorPath,
  );
  for (const block of output.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const worktree = lines.find((line) => line.startsWith('worktree '));
    const head = lines.find((line) => line.startsWith('HEAD '));
    if (
      worktree !== undefined &&
      head !== undefined &&
      path.resolve(worktree.slice('worktree '.length)) ===
        path.resolve(checkoutPath)
    ) {
      return {
        path: path.resolve(worktree.slice('worktree '.length)),
        head: head.slice('HEAD '.length),
      };
    }
  }
  return null;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function requireWorkspaceRepoByKey(
  workspace: Workspace,
  key: string,
): WorkspaceRepo {
  const repo = workspace.repos.find((item) => item.key === key);
  if (repo === undefined) {
    throw new Error(`Workspace repository state is missing: ${key}`);
  }
  return repo;
}

function requireWorkspaceRepoById(
  workspace: Workspace,
  repositoryId: string,
): WorkspaceRepo {
  const repo = workspace.repos.find(
    (item) => item.repositoryId === repositoryId,
  );
  if (repo === undefined) {
    throw new Error(`Workspace repository id is missing: ${repositoryId}`);
  }
  return repo;
}

function requireWorktreeInfo(
  values: ReadonlyMap<
    string,
    { readonly path: string; readonly head: string } | null
  >,
  repositoryId: string,
): { readonly path: string; readonly head: string } | null {
  const value = values.get(repositoryId);
  if (value === undefined) {
    throw new Error(`Worktree observation is missing: ${repositoryId}`);
  }
  return value;
}

function detachedHead(
  repo: WorkspaceRepo,
  info: { readonly path: string; readonly head: string } | null,
): string {
  if (repo.headCommit !== null) return repo.headCommit;
  if (info !== null) return info.head;
  throw new Error(`Detached checkout commit is unavailable: ${repo.key}`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertActive(workspace: Workspace): void {
  if (workspace.status !== 'active') {
    throw new Error(
      `Workspace is not active: ${workspace.kind}/${workspace.name}`,
    );
  }
}

function validateWorkspaceStatus(value: string): WorkspaceStatus {
  if (
    value === 'active' ||
    value === 'archived' ||
    value === 'missing' ||
    value === 'deleted'
  ) {
    return value;
  }
  throw new Error(`Invalid workspace status: ${value}`);
}
