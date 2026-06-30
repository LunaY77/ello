import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { projectWorkspacePointerPath } from '../config/index.js';
import { WorkspaceRepository } from '../storage/repositories/workspace-repository.js';
import { stringifyTomlConfig } from '../utils/toml.js';

import { git } from './git.js';
import { archiveDir, workspaceDir } from './paths.js';
import {
  addWorkspaceRepos,
  archiveWorkspace,
  buildWorkspaceManifest,
  classifyWorkspaceRepo,
  planWorkspaceCreate,
  planWorkspaceRepo,
  removeWorkspaceRepos,
  renameWorkspace,
} from './plan.js';
import { RepoStore } from './repo-store.js';
import { slugify, validateKind, validateRepoKey } from './slug.js';
import type {
  RepoEntry,
  WorkspaceKind,
  WorkspaceManifest,
  WorkspaceRepo,
} from './types.js';

/** workspace 管理：创建 worktree，并把结构化状态写入全局 SQLite。 */
export class WorkspaceStore {
  constructor(
    private readonly repos = new RepoStore(),
    private readonly repository = new WorkspaceRepository(),
  ) {}

  async create(
    kindInput: string,
    nameInput: string,
    repoKeys: readonly string[],
    options: {
      readonly tmuxSession?: string | undefined;
    } = {},
  ): Promise<WorkspaceManifest> {
    const rootPath = await workspaceDir(validateKind(kindInput), slugify(nameInput));
    const plan = planWorkspaceCreate({
      kind: kindInput,
      name: nameInput,
      rootPath,
      repoKeys,
    });
    await mkdir(rootPath, { recursive: true });
    const repos = await Promise.all(
      plan.repoKeys.map((key) =>
        this.attachRepo({
          rootPath: plan.rootPath,
          kind: plan.kind,
          workspaceName: plan.name,
          branch: plan.branch,
          key,
        }),
      ),
    );
    const now = new Date().toISOString();
    const manifest = buildWorkspaceManifest({
      plan,
      repos,
      now,
      ...(options.tmuxSession !== undefined
        ? { tmuxSession: options.tmuxSession }
        : {}),
    });
    await this.persistWorkspace(manifest);
    return manifest;
  }

  async list(kindInput?: string): Promise<readonly WorkspaceManifest[]> {
    return this.repository.list(
      kindInput === undefined ? undefined : validateKind(kindInput),
    );
  }

  async open(kind: string, name: string): Promise<WorkspaceManifest> {
    const manifest = await this.repository.open(validateKind(kind), slugify(name));
    if (manifest === null) {
      throw new Error(`Unknown workspace: ${kind}/${name}`);
    }
    return manifest;
  }

  async addRepos(
    kind: string,
    name: string,
    repoKeys: readonly string[],
  ): Promise<WorkspaceManifest> {
    const manifest = await this.open(kind, name);
    const existing = new Set(manifest.repos.map((repo) => repo.key));
    const added = await Promise.all(
      repoKeys
        .map(validateRepoKey)
        .filter((key) => !existing.has(key))
        .map((key) =>
          this.attachRepo({
            rootPath: manifest.rootPath,
            kind: manifest.kind,
            workspaceName: manifest.name,
            branch: manifest.branch,
            key,
          }),
        ),
    );
    const next = addWorkspaceRepos(manifest, added, new Date().toISOString());
    await this.persistWorkspace(next);
    return next;
  }

  async removeRepos(
    kind: string,
    name: string,
    repoKeys: readonly string[],
    force = false,
  ): Promise<WorkspaceManifest> {
    const manifest = await this.open(kind, name);
    const removing = new Set(repoKeys.map(validateRepoKey));
    for (const repo of manifest.repos.filter((repo) =>
      removing.has(repo.key),
    )) {
      if (!force) {
        const status = await git(['status', '--porcelain'], repo.path);
        if (status !== '') {
          throw new Error(`Workspace repo is dirty: ${repo.key}`);
        }
      }
      await this.removeWorktree(repo, force);
    }
    const next = removeWorkspaceRepos(
      manifest,
      [...removing],
      new Date().toISOString(),
    );
    await this.persistWorkspace(next);
    return next;
  }

  async rename(
    kind: string,
    name: string,
    newNameInput: string,
  ): Promise<WorkspaceManifest> {
    const manifest = await this.open(kind, name);
    const newName = slugify(newNameInput);
    const target = await workspaceDir(manifest.kind, newName);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(manifest.rootPath, target);
    const next = renameWorkspace(
      manifest,
      target,
      newName,
      new Date().toISOString(),
    );
    await this.persistWorkspace(next);
    return next;
  }

  async remove(kind: string, name: string, force = false): Promise<boolean> {
    const manifest = await this.open(kind, name);
    if (!force) {
      await this.assertClean(manifest);
    }
    for (const repo of manifest.repos) {
      await this.removeWorktree(repo, true);
    }
    await rm(manifest.rootPath, { recursive: true, force: true });
    await this.repository.markDeleted(manifest.kind, manifest.name);
    return true;
  }

  async archive(kind: string, name: string): Promise<WorkspaceManifest> {
    const manifest = await this.open(kind, name);
    await this.assertClean(manifest);
    for (const repo of manifest.repos) {
      await this.removeWorktree(repo, false);
    }
    const target = path.join(archiveDir(), manifest.kind, manifest.name);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(manifest.rootPath, target);
    const next = archiveWorkspace(manifest, target, new Date().toISOString());
    await this.repository.markArchived(next);
    return next;
  }

  async status(): Promise<readonly Record<string, unknown>[]> {
    const manifests = await this.list();
    return Promise.all(
      manifests.map(async (manifest) => ({
        name: manifest.name,
        kind: manifest.kind,
        rootPath: manifest.rootPath,
        repos: await Promise.all(
          manifest.repos.map(async (repo) => ({
            key: repo.key,
            path: repo.path,
            dirty: (await git(['status', '--porcelain'], repo.path)) !== '',
          })),
        ),
      })),
    );
  }

  async sync(
    options: { readonly fixMissing?: boolean; readonly prune?: boolean } = {},
  ): Promise<ReturnType<WorkspaceRepository['sync']>> {
    const manifests = await this.list();
    const diffs = await Promise.all(
      manifests.map(async (manifest) => ({
        workspace: manifest,
        missingRoot: !(await exists(manifest.rootPath)),
        repos: await Promise.all(
          manifest.repos.map(async (repo) => {
            if (!(await exists(repo.path))) {
              return classifyWorkspaceRepo({ repo, exists: false });
            }
            const gitStatus = await git(['status', '--porcelain'], repo.path);
            return classifyWorkspaceRepo({ repo, exists: true, gitStatus });
          }),
        ),
      })),
    );
    return this.repository.sync(diffs, options);
  }

  private async attachRepo(input: {
    readonly rootPath: string;
    readonly kind: WorkspaceKind;
    readonly workspaceName: string;
    readonly branch?: string | undefined;
    readonly key: string;
  }): Promise<WorkspaceRepo> {
    const planned = planWorkspaceRepo(input);
    const repo = await this.requireRepo(planned.key);
    const startPoint =
      repo.defaultBranch !== undefined
        ? `origin/${repo.defaultBranch}`
        : 'HEAD';
    if (input.kind === 'explore') {
      await git(
        ['worktree', 'add', '--detach', planned.path, startPoint],
        repo.mirrorPath,
      );
    } else {
      await git(
        ['worktree', 'add', '-B', planned.branch!, planned.path, startPoint],
        repo.mirrorPath,
      );
    }
    return planned;
  }

  private async requireRepo(key: string): Promise<RepoEntry> {
    const repo = await this.repos.show(key);
    if (repo === null) {
      throw new Error(`Unknown repo: ${key}`);
    }
    return repo;
  }

  private async persistWorkspace(manifest: WorkspaceManifest): Promise<void> {
    for (const repo of manifest.repos) {
      await this.repository.upsertRepo(await this.requireRepo(repo.key));
    }
    await this.repository.save(manifest);
    await writeProjectWorkspacePointer(manifest);
  }

  private async assertClean(manifest: WorkspaceManifest): Promise<void> {
    for (const repo of manifest.repos) {
      const status = await git(['status', '--porcelain'], repo.path);
      if (status !== '') {
        throw new Error(`Workspace repo is dirty: ${repo.key}`);
      }
    }
  }

  private async removeWorktree(
    workspaceRepo: WorkspaceRepo,
    force: boolean,
  ): Promise<void> {
    const repo = await this.requireRepo(workspaceRepo.key);
    await git(
      ['worktree', 'remove', workspaceRepo.path, ...(force ? ['--force'] : [])],
      repo.mirrorPath,
    );
  }
}

async function writeProjectWorkspacePointer(
  manifest: WorkspaceManifest,
): Promise<void> {
  // 每个 checkout 写入本地指针，进入子仓后也能反查所在 workspace。
  await Promise.all(
    manifest.repos.map(async (repo) => {
      await mkdir(path.join(repo.path, '.ello'), { recursive: true });
      await writeFile(
        projectWorkspacePointerPath(repo.path),
        stringifyTomlConfig({
          name: manifest.name,
          kind: manifest.kind,
          rootPath: manifest.rootPath,
          ...(manifest.branch !== undefined ? { branch: manifest.branch } : {}),
          ...(manifest.tmuxSession !== undefined
            ? { tmuxSession: manifest.tmuxSession }
            : {}),
          repoKey: repo.key,
        }),
        'utf8',
      );
    }),
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
