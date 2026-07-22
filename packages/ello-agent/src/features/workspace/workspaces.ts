/**
 * WorkspaceStore 管理任务目录、各仓库的工作目录、任务分支、归档和恢复。
 * Git 提交和分支保存在 RepoStore 管理的 bare mirror 中；Workspace 保存任务目录、
 * 工作目录位置和生命周期状态。
 *
 * 创建 `feature/name`、`fix/name` 或 `refactor/name` 时：校验 selector 和 repo key，
 * 从 SQLite 找到 Repository，确认每个仓库都有 Workspace 起点，创建
 * `repos/references/docs/tmp` 目录，从 Workspace 起点创建或复用同名分支，为每个仓库
 * 挂载工作目录，清除隐式 upstream，最后写入 Workspace 和各 checkout 的结构化记录。
 *
 * 跨仓库任务使用与 selector 同名的 `feature/name`、`fix/name` 或 `refactor/name`
 * 分支，分支默认不绑定 upstream，远端发布由用户显式执行，系统不创建远端分支。
 * `explore/name` 从 Workspace 起点挂载 detached 工作目录，不占用任务分支。
 *
 * `addRepos` 和 `removeRepos` 修改任务中的仓库集合；`rename` 移动任务目录并修复
 * worktree 连接；`archive` 保存完整任务现场、释放工作分支并允许同名任务创建新代；
 * `repair` 根据 SQLite 和 mirror 状态恢复缺失目录及 checkout；`delete` 清理任务
 * 的 tmux、worktree、目录和记录。遇到 dirty 文件、非 Git 占位目录或不安全冲突时失败。
 * RepoStore 提供仓库和 Workspace 起点，WorkspaceRecordStore 提供任务记录，TmuxStore
 * 管理终端会话；WorkspaceStore 负责协调三者。
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { errnoCode } from '../../infra/filesystem.js';
import { CommandError, git } from '../../infra/git.js';

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
} from './repositories.js';
import { validateRepoKey, type Repository } from './repository.js';
import { slugify, validateKind } from './slug.js';
import type { WorkspaceRecordStore } from './store.js';
import { TmuxStore } from './tmux.js';
import type {
  Workspace,
  WorkspaceRepo,
  WorkspaceRepoRole,
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
  /**
   * 创建 `WorkspaceStore`，由该实例独占 Workspace `workspaces` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   * - `repos`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   * - `mount`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   * - `tmux`: `constructor WorkspaceStore` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   */
  constructor(
    private readonly repository: WorkspaceRecordStore,
    private readonly repos: RepoStore,
    private readonly mount: string,
    private readonly tmux = new TmuxStore(),
  ) {}

  /**
   * 执行 Workspace `workspaces` 模块 定义的 `initializeMount` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async initializeMount(): Promise<void> {
    await mkdir(activeWorkspacesDir(this.mount), { recursive: true });
    await mkdir(archivedWorkspacesDir(this.mount), { recursive: true });
  }

  /**
   * 构造 Workspace `workspaces` 模块 中的 `create` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `kindInput`: `create` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `nameInput`: `create` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `repoKeys`: `create` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `tmuxSession`: `create` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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
    await mkdir(path.join(plan.rootPath, 'references'));
    await mkdir(path.join(plan.rootPath, 'tmp'));
    await mkdir(path.join(plan.rootPath, 'docs'));
    const checkouts: WorkspaceRepo[] = [];
    for (const repo of selected) {
      checkouts.push(
        await this.attachRepo(plan.rootPath, repo, plan.branch, 'development'),
      );
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

  /**
   * 读取 Workspace `workspaces` 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `filters`: `list` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
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

  /**
   * 读取 Workspace `workspaces` 模块 的 `listRepairable` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  listRepairable(): readonly Workspace[] {
    return [
      ...this.repository.list({ status: 'active' }),
      ...this.repository.list({ status: 'archived' }),
      ...this.repository.list({ status: 'missing' }),
    ].sort((left, right) => left.rootPath.localeCompare(right.rootPath));
  }

  /**
   * 读取 Workspace `workspaces` 模块 的 `listArchived` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `kindInput`: `listArchived` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `nameInput`: `listArchived` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  listArchived(kindInput: string, nameInput: string): readonly Workspace[] {
    return this.repository.listArchived(
      validateKind(kindInput),
      slugify(nameInput),
    );
  }

  /**
   * 构造 Workspace `workspaces` 模块 中的 `open` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `kindInput`: `open` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `nameInput`: `open` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `open` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  open(kindInput: string, nameInput: string): Workspace {
    const kind = validateKind(kindInput);
    const name = slugify(nameInput);
    const workspace = this.repository.find(kind, name);
    if (workspace === null || workspace.status === 'deleted') {
      throw new Error(`Unknown workspace: ${kind}/${name}`);
    }
    return workspace;
  }

  /**
   * 构造 Workspace `workspaces` 模块 中的 `openActive` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `kindInput`: `openActive` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `nameInput`: `openActive` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `openActive` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  openActive(kindInput: string, nameInput: string): Workspace {
    const kind = validateKind(kindInput);
    const name = slugify(nameInput);
    const workspace = this.repository.findActive(kind, name);
    if (workspace === null || workspace.status !== 'active') {
      throw new Error(`Unknown active workspace: ${kind}/${name}`);
    }
    return workspace;
  }

  /**
   * 构造 Workspace `workspaces` 模块 中的 `openArchived` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `kindInput`: `openArchived` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `nameInput`: `openArchived` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回 `openArchived` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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

  /**
   * 构造 Workspace `workspaces` 模块 中的 `openById` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回 `openById` 计算出的声明结果；返回值不包含未声明的兜底状态。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  openById(id: string): Workspace {
    const workspace = this.repository.findById(id);
    if (workspace === null || workspace.status === 'deleted') {
      throw new Error(`Unknown workspace id: ${id}`);
    }
    return workspace;
  }

  /**
   * 执行 Workspace `workspaces` 模块 定义的 `fromCwd` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   *
   * Returns:
   * - 返回 `fromCwd` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  fromCwd(cwd: string): Workspace {
    const workspace = this.repository.findActiveByRoot(path.resolve(cwd));
    if (workspace === null) {
      throw new Error(
        `Current directory is not a workspace root: ${path.resolve(cwd)}`,
      );
    }
    return workspace;
  }

  /**
   * 按 Workspace `workspaces` 模块 的一致性约束执行 `addRepos` 状态变更。
   *
   * Args:
   * - `workspace`: `addRepos` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `repoKeys`: `addRepos` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `role`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async addRepos(
    workspace: Workspace,
    repoKeys: readonly string[],
    role: WorkspaceRepoRole = 'development',
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
    const branch = role === 'reference' ? null : workspace.branch;
    for (const repo of selected)
      added.push(await this.attachRepo(workspace.rootPath, repo, branch, role));
    const next = {
      ...workspace,
      repos: [...workspace.repos, ...added],
      updatedAt: new Date().toISOString(),
    };
    return this.repository.update(next);
  }

  /**
   * 构造 Workspace `workspaces` 模块 中的 `createRepo` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `workspace`: `createRepo` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `key`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async createRepo(workspace: Workspace, key: string): Promise<Workspace> {
    assertActive(workspace);
    const repo = await this.repos.createManaged(
      key,
      'main',
      workspace.rootPath,
    );
    return this.addRepos(workspace, [repo.key]);
  }

  /**
   * 按 Workspace `workspaces` 模块 的一致性约束执行 `removeRepos` 状态变更。
   *
   * Args:
   * - `workspace`: `removeRepos` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `repoKeys`: `removeRepos` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `force`: 显式控制 `removeRepos` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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

  /**
   * 构造 Workspace `workspaces` 模块 中的 `bindTmux` 结果，并在返回前建立所需的不变量。
   *
   * Args:
   * - `workspace`: `bindTmux` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `session`: `bindTmux` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 执行 Workspace `workspaces` 模块 定义的 `rename` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `workspace`: `rename` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `newNameInput`: `rename` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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
    if (workspace.tmuxSession !== null && nextTmux !== null) {
      await this.tmux.assertSessionAvailable(nextTmux);
      await this.tmux.renameSession(workspace.tmuxSession, nextTmux);
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

  /**
   * 按 Workspace `workspaces` 模块 的一致性约束执行 `archive` 状态变更。
   *
   * Args:
   * - `workspace`: `archive` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 按 Workspace `workspaces` 模块 的一致性约束执行 `delete` 状态变更。
   *
   * Args:
   * - `workspace`: `delete` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `force`: 显式控制 `delete` 分支的布尔值；只影响当前调用。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Workspace `workspaces` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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

  /**
   * 读取 Workspace `workspaces` 模块 的 `status` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `workspaces`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 执行 Workspace `workspaces` 模块 定义的 `reconcile` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `workspaces`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   *
   * Returns:
   * - 返回 `reconcile` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
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

  /**
   * 执行 Workspace `workspaces` 模块 定义的 `repair` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `workspaces`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   *
   * Returns:
   * - Promise 在 Workspace `workspaces` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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
      path: path.join(
        expectedRoot,
        repo.role === 'reference' ? 'references' : 'repos',
        repo.key,
      ),
    }));
    for (const role of ['development', 'reference'] as const) {
      const expectedDir = path.join(
        expectedRoot,
        role === 'reference' ? 'references' : 'repos',
      );
      if (await exists(expectedDir)) {
        const managedKeys = new Set(
          expectedRepos
            .filter((repo) => repo.role === role)
            .map((repo) => repo.key.split('/')[0]),
        );
        const unexpected = (await readdir(expectedDir)).filter(
          (entry) => !managedKeys.has(entry),
        );
        if (unexpected.length > 0)
          throw new Error(
            `Workspace has unmanaged ${role === 'reference' ? 'references' : 'repo'} directories: ${unexpected.join(', ')}`,
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
    const directories = ['repos', 'references', 'tmp', 'docs'] as const;
    for (const directory of directories) {
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
      await mkdir(path.dirname(repo.path), { recursive: true });
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
    role: WorkspaceRepoRole,
  ): Promise<WorkspaceRepo> {
    if (branch !== null) assertRepositoryUserBranch(branch);
    const checkout = planWorkspaceRepo(rootPath, repository, branch, role);
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
    if (errnoCode(error) === 'ENOENT') return false;
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
