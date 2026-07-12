import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodingStorage, type CodingStorage } from '../storage/index.js';
import { git } from '../workspace/git.js';
import {
  formatRepoList,
  formatWorkspaceList,
  RepoStore,
  WorkspaceStore,
} from '../workspace/index.js';
import { resolveWorkspaceMount } from '../workspace/paths.js';
import { slugify, validateKind, validateRepoKey } from '../workspace/slug.js';

describe('workspace', () => {
  let oldHome: string | undefined;
  let home: string;
  let mount: string;
  let sourceRepo: string;
  let storage: CodingStorage;
  let repos: RepoStore;
  let workspaces: WorkspaceStore;

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-home-'));
    mount = await mkdtemp(path.join(tmpdir(), 'ello-workspaces-'));
    sourceRepo = await mkdtemp(path.join(tmpdir(), 'ello-source-'));
    process.env.ELLO_HOME = home;
    storage = createCodingStorage();
    repos = new RepoStore(storage.repositories);
    workspaces = new WorkspaceStore(storage.workspaces, repos, mount);
  });

  afterEach(async () => {
    storage.close();
    if (oldHome === undefined) delete process.env.ELLO_HOME;
    else process.env.ELLO_HOME = oldHome;
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(mount, { recursive: true, force: true }),
      rm(sourceRepo, { recursive: true, force: true }),
    ]);
  });

  it('校验 selector 组成和 mount', () => {
    expect(validateRepoKey('ello-ts')).toBe('ello-ts');
    expect(() => validateRepoKey('../bad')).toThrow('Invalid repo key');
    expect(validateKind('feature')).toBe('feature');
    expect(validateKind('fix')).toBe('fix');
    expect(validateKind('explore')).toBe('explore');
    expect(() => validateKind('other')).toThrow('Invalid workspace kind');
    expect(slugify('Add Settings Rewrite')).toBe('add-settings-rewrite');
    expect(resolveWorkspaceMount('~/.ello')).toBe(
      path.join(process.env.HOME!, '.ello'),
    );
    expect(() => resolveWorkspaceMount('relative')).toThrow(
      'Workspace mount must be an absolute path',
    );
  });

  it('本地导入使用稳定 ID、nullable remote 和独立 mirror', async () => {
    await initializeSourceRepo(sourceRepo);
    const added = await repos.add(sourceRepo, 'demo');
    expect(added).toMatchObject({ key: 'demo', remoteUrl: null });
    expect(added.mirrorPath).toBe(
      path.join(home, 'mirrors', `${added.id}.git`),
    );
    await expect(
      git(['remote', 'get-url', 'origin'], added.mirrorPath),
    ).rejects.toThrow();

    const renamed = repos.rename('demo', 'renamed');
    expect(renamed.id).toBe(added.id);
    expect(renamed.mirrorPath).toBe(added.mirrorPath);
    expect(formatRepoList([renamed])).toContain('<local-only>');

    await expect(repos.remoteAdd('renamed', sourceRepo)).resolves.toMatchObject(
      {
        remoteUrl: sourceRepo,
      },
    );
    await expect(
      repos.remoteSet('renamed', `${sourceRepo}/next`),
    ).resolves.toMatchObject({
      remoteUrl: `${sourceRepo}/next`,
    });
    await expect(repos.remoteRemove('renamed')).resolves.toMatchObject({
      remoteUrl: null,
    });
  });

  it('远端导入保留 origin，local-only fetch 明确失败', async () => {
    await initializeSourceRepo(sourceRepo);
    const remote = await repos.add(`file://${sourceRepo}`, 'remote');
    expect(remote.remoteUrl).toBe(`file://${sourceRepo}`);
    expect(await git(['remote', 'get-url', 'origin'], remote.mirrorPath)).toBe(
      `file://${sourceRepo}`,
    );
    await expect(repos.fetch(['remote'])).resolves.toEqual([
      { key: 'remote', status: 'fetched' },
    ]);

    await repos.add(sourceRepo, 'local');
    await expect(repos.fetch(['local'])).rejects.toThrow(
      'Repository has no remote: local',
    );
    await expect(repos.fetch([], true)).resolves.toContainEqual({
      key: 'local',
      status: 'no_remote',
    });
  });

  it('创建标准目录、共同分支且不写 marker 或 manifest', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const workspace = await workspaces.create('feature', 'Add API', ['demo']);

    expect(workspace).toMatchObject({
      kind: 'feature',
      name: 'add-api',
      status: 'active',
      branch: 'feature/add-api',
      tmuxSession: null,
    });
    expect(workspace.repos[0]).toMatchObject({
      key: 'demo',
      checkoutMode: 'branch',
      branch: 'feature/add-api',
      path: path.join(
        mount,
        'workspace',
        'feature',
        'add-api',
        'repos',
        'demo',
      ),
    });
    expect(await readdir(workspace.rootPath)).toEqual(['docs', 'repos', 'tmp']);
    expect(await readdir(path.join(workspace.rootPath, 'docs'))).toEqual([]);
    expect(await readdir(path.join(workspace.rootPath, 'tmp'))).toEqual([]);
    await expect(
      access(path.join(workspace.rootPath, '.ello')),
    ).rejects.toThrow();
    await expect(
      access(path.join(workspace.rootPath, 'workspace.yaml')),
    ).rejects.toThrow();
    expect(formatWorkspaceList([workspace])).toContain('feature');
  });

  it('创建受管新 repo 后加入现有 workspace', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const workspace = await workspaces.create('feature', 'New Service', [
      'demo',
    ]);
    await repos.createManaged('new-service', 'main', sourceRepo);
    const updated = await workspaces.addRepos(workspace, ['new-service']);
    expect(updated.repos.map((repo) => repo.key)).toEqual([
      'demo',
      'new-service',
    ]);
    expect(updated.repos[1]).toMatchObject({
      branch: 'feature/new-service',
      checkoutMode: 'branch',
    });
    expect(repos.show('new-service')).toMatchObject({ remoteUrl: null });
  });

  it('archive 保留完整 checkout、修复 worktree 路径且删除时清理元数据', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const workspace = await workspaces.create('explore', 'Inspect', ['demo']);
    expect(workspace.branch).toBeNull();
    expect(workspace.repos[0]).toMatchObject({
      checkoutMode: 'detached',
      branch: null,
    });
    await writeFile(
      path.join(workspace.rootPath, 'docs', 'notes.md'),
      'keep\n',
    );

    const archived = await workspaces.archive(workspace);
    expect(archived.status).toBe('archived');
    expect(archived.rootPath).toMatch(
      new RegExp(
        `^${escapeRegExp(path.join(mount, 'archive', 'explore', 'inspect-'))}`,
        'u',
      ),
    );
    expect(
      await readFile(path.join(archived.rootPath, 'docs', 'notes.md'), 'utf8'),
    ).toBe('keep\n');
    expect(await readdir(path.join(archived.rootPath, 'repos'))).toEqual([
      'demo',
    ]);
    expect(
      await readFile(
        path.join(archived.rootPath, 'repos', 'demo', 'README.md'),
        'utf8',
      ),
    ).toBe('hello\n');
    expect(await git(['status', '--porcelain'], archived.repos[0]!.path)).toBe(
      '',
    );
    const mirrorPath = repos.show('demo')!.mirrorPath;
    expect(await git(['worktree', 'list', '--porcelain'], mirrorPath)).toContain(
      archived.repos[0]!.path,
    );
    expect(workspaces.list({ status: 'archived' })).toMatchObject([
      { id: archived.id, status: 'archived' },
    ]);

    const archivedHead = await git(['rev-parse', 'HEAD'], archived.repos[0]!.path);
    await rm(archived.repos[0]!.path, { recursive: true });
    const repaired = await workspaces.repair([archived]);
    expect(repaired[0]!.actions).toContain('restored_checkout:demo');
    expect(await git(['rev-parse', 'HEAD'], archived.repos[0]!.path)).toBe(
      archivedHead,
    );

    await workspaces.delete(archived, false);
    expect(
      await git(['worktree', 'list', '--porcelain'], mirrorPath),
    ).not.toContain(archived.repos[0]!.path);
  });

  it('reconcile 只诊断，repair 自动重建被人工删除的 workspace', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const workspace = await workspaces.create('feature', 'Repair Me', ['demo']);
    await rm(workspace.rootPath, { recursive: true });

    const diagnosis = await workspaces.reconcile([workspace]);
    expect(diagnosis.observations[0]).toMatchObject({ missingRoot: true });
    expect(storage.workspaces.find('feature', 'repair-me')).toMatchObject({
      status: 'active',
    });

    const repaired = await workspaces.repair([workspace]);
    expect(repaired[0]!.actions).toEqual([
      'created_root',
      'created_repos_directory',
      'created_tmp_directory',
      'created_docs_directory',
      'restored_checkout:demo',
    ]);
    expect(
      await readFile(
        path.join(workspace.rootPath, 'repos', 'demo', 'README.md'),
        'utf8',
      ),
    ).toBe('hello\n');
    expect(await readdir(path.join(workspace.rootPath, 'tmp'))).toEqual([]);
    expect(await readdir(path.join(workspace.rootPath, 'docs'))).toEqual([]);
    expect(repaired[0]!.status).toMatchObject({
      missingRoot: false,
      repos: [{ key: 'demo', missing: false, dirty: false }],
    });
  });

  it('repair 能恢复旧 archive 逻辑删除的 feature checkout', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'aidraw-server');
    const workspace = await workspaces.create('feature', 'Test', [
      'aidraw-server',
    ]);
    const archived = await workspaces.archive(workspace);
    const mirrorPath = repos.show('aidraw-server')!.mirrorPath;
    await git(
      ['worktree', 'remove', archived.repos[0]!.path],
      mirrorPath,
    );
    await rm(archived.rootPath, { recursive: true });

    const repaired = await workspaces.repair([archived]);
    expect(repaired[0]!.actions).toContain('created_root');
    expect(repaired[0]!.actions).toContain(
      'restored_checkout:aidraw-server',
    );
    expect(
      await readFile(
        path.join(
          archived.rootPath,
          'repos',
          'aidraw-server',
          'README.md',
        ),
        'utf8',
      ),
    ).toBe('hello\n');
    await expect(
      git(['symbolic-ref', '--short', 'HEAD'], archived.repos[0]!.path),
    ).rejects.toThrow('HEAD is not a symbolic ref');

    const newGeneration = await workspaces.create('feature', 'Test', [
      'aidraw-server',
    ]);
    expect(newGeneration).toMatchObject({
      status: 'active',
      rootPath: path.join(mount, 'workspace', 'feature', 'test'),
    });
    expect(newGeneration.id).not.toBe(archived.id);
    expect(
      await readFile(
        path.join(
          newGeneration.rootPath,
          'repos',
          'aidraw-server',
          'README.md',
        ),
        'utf8',
      ),
    ).toBe('hello\n');
    await expect(access(archived.rootPath)).resolves.toBeUndefined();
  });

  it('archived selector 不限制新 workspace 的 repo 集合', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const workspace = await workspaces.create('feature', 'Mismatch', ['demo']);
    const archived = await workspaces.archive(workspace);

    const active = await workspaces.create('feature', 'Mismatch', []);
    expect(active).toMatchObject({ status: 'active', repos: [] });
    expect(active.id).not.toBe(archived.id);
    expect(workspaces.listArchived('feature', 'mismatch')).toMatchObject([
      { id: archived.id, status: 'archived' },
    ]);
  });

  it('同 selector 支持多代 archive，删除时多版本必须使用 workspace id', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');

    const first = await workspaces.create('feature', 'Generations', ['demo']);
    const firstArchive = await workspaces.archive(first);
    const second = await workspaces.create('feature', 'Generations', ['demo']);
    const secondArchive = await workspaces.archive(second);
    const third = await workspaces.create('feature', 'Generations', ['demo']);

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(firstArchive.rootPath).not.toBe(secondArchive.rootPath);
    expect(workspaces.listArchived('feature', 'generations')).toMatchObject([
      { id: secondArchive.id },
      { id: firstArchive.id },
    ]);
    expect(() => workspaces.openArchived('feature', 'generations')).toThrow(
      'Archived workspace selector is ambiguous',
    );

    await workspaces.delete(workspaces.openById(firstArchive.id), false);
    expect(workspaces.openArchived('feature', 'generations')).toMatchObject({
      id: secondArchive.id,
    });
    await expect(repos.remove('demo')).rejects.toThrow(
      'Repository is referenced by workspace',
    );
  });

  it('repair 将旧 missing 状态和错误 DB 路径收敛到规范路径', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const workspace = await workspaces.create('fix', 'Canonical', ['demo']);
    const wrongRoot = path.join(mount, 'manually-moved', 'canonical');
    const drifted = storage.workspaces.update({
      ...workspace,
      rootPath: wrongRoot,
      status: 'missing',
      repos: workspace.repos.map((repo) => ({
        ...repo,
        path: path.join(wrongRoot, 'repos', repo.key),
      })),
      updatedAt: new Date().toISOString(),
    });

    const repaired = await workspaces.repair([drifted]);
    expect(repaired[0]!.actions).toEqual([
      'repaired_worktree:demo',
      'updated_database',
    ]);
    expect(repaired[0]!.workspace).toMatchObject({
      rootPath: workspace.rootPath,
      status: 'active',
    });
  });

  it('非 Git 目录占位时 reconcile 报告 invalid，repair 不删除用户目录', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const workspace = await workspaces.create('feature', 'Invalid', ['demo']);
    const mirrorPath = repos.show('demo')!.mirrorPath;
    await git(['worktree', 'remove', workspace.repos[0]!.path], mirrorPath);
    await mkdir(workspace.repos[0]!.path);
    await writeFile(path.join(workspace.repos[0]!.path, 'keep.txt'), 'keep\n');

    const diagnosis = await workspaces.reconcile([workspace]);
    expect(diagnosis.observations[0]!.repos[0]).toMatchObject({
      status: 'invalid',
    });
    await expect(workspaces.repair([workspace])).rejects.toThrow();
    expect(
      await readFile(path.join(workspace.repos[0]!.path, 'keep.txt'), 'utf8'),
    ).toBe('keep\n');
  });

  it('dirty worktree fail fast，repo 引用阻止删除', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const workspace = await workspaces.create('fix', 'Bug', ['demo']);
    await writeFile(
      path.join(workspace.repos[0]!.path, 'dirty.txt'),
      'dirty\n',
    );

    await expect(workspaces.archive(workspace)).rejects.toThrow(
      'Workspace repo is dirty',
    );
    await expect(repos.remove('demo')).rejects.toThrow(
      'Repository is referenced by workspace',
    );
    const deleted = await workspaces.delete(workspace, true);
    expect(deleted.status).toBe('deleted');
    await expect(repos.remove('demo')).resolves.toBeUndefined();
  });

  it('local-only export/import 通过 bundle 重建 registry', async () => {
    await initializeSourceRepo(sourceRepo);
    await repos.add(sourceRepo, 'demo');
    const output = path.join(mount, 'portable');
    const exported = await repos.export([], output);
    expect(exported.repositories[0]).toMatchObject({
      key: 'demo',
      remoteUrl: null,
      bundle: 'bundles/demo.bundle',
    });

    storage.close();
    await rm(home, { recursive: true, force: true });
    const importedHome = await mkdtemp(
      path.join(tmpdir(), 'ello-import-home-'),
    );
    home = importedHome;
    process.env.ELLO_HOME = importedHome;
    storage = createCodingStorage();
    repos = new RepoStore(storage.repositories);
    const imported = await repos.import(output);
    expect(imported[0]).toMatchObject({
      key: 'demo',
      remoteUrl: null,
    });
  });
});

async function initializeSourceRepo(repoPath: string): Promise<void> {
  await git(['init', '--initial-branch', 'main', repoPath]);
  await git(['config', 'user.email', 'ello@example.test'], repoPath);
  await git(['config', 'user.name', 'Ello Test'], repoPath);
  await mkdir(path.join(repoPath, 'src'));
  await writeFile(path.join(repoPath, 'README.md'), 'hello\n');
  await git(['add', '.'], repoPath);
  await git(['commit', '-m', 'init'], repoPath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
