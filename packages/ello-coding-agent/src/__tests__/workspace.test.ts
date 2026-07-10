import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodingStorage } from '../storage/index.js';
import { git } from '../workspace/git.js';
import {
  formatRepoList,
  formatWorkspaceList,
  RepoStore,
  WorkspaceStore,
} from '../workspace/index.js';
import {
  workspaceManifestPath,
  workspaceYamlManifestPath,
} from '../workspace/paths.js';
import { slugify, validateKind, validateRepoKey } from '../workspace/slug.js';

describe('workspace helpers', () => {
  let oldHome: string | undefined;
  let home: string;
  let sourceRepo: string;

  beforeEach(async () => {
    oldHome = process.env.ELLO_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'ello-home-'));
    sourceRepo = await mkdtemp(path.join(tmpdir(), 'ello-source-'));
    process.env.ELLO_HOME = home;
  });

  afterEach(async () => {
    if (oldHome === undefined) {
      delete process.env.ELLO_HOME;
    } else {
      process.env.ELLO_HOME = oldHome;
    }
    await rm(home, { recursive: true, force: true });
    await rm(sourceRepo, { recursive: true, force: true });
  });

  it('校验 repo key', () => {
    expect(validateRepoKey('ello-ts')).toBe('ello-ts');
    expect(() => validateRepoKey('../bad')).toThrow('Invalid repo key');
  });

  it('校验 workspace kind', () => {
    expect(validateKind('feature')).toBe('feature');
    expect(validateKind('fix')).toBe('fix');
    expect(validateKind('explore')).toBe('explore');
    expect(() => validateKind('other')).toThrow('Invalid workspace kind');
  });

  it('生成稳定 slug', () => {
    expect(slugify('Add Settings Rewrite')).toBe('add-settings-rewrite');
  });

  it('渲染 repo 和 workspace 列表', () => {
    expect(
      formatRepoList([
        {
          key: 'ello',
          url: '/tmp/ello',
          mirrorPath: '/tmp/mirrors/ello.git',
          defaultBranch: 'main',
          createdAt: 'now',
          updatedAt: 'now',
        },
      ]),
    ).toContain('ello');

    expect(
      formatWorkspaceList([
        {
          kind: 'explore',
          name: 'inspect',
          rootPath: '/tmp/ws',
          repos: [{ key: 'ello', path: '/tmp/ws/ello' }],
          createdAt: 'now',
          updatedAt: 'now',
        },
      ]),
    ).toContain('explore');
  });

  it('真实 git worktree 覆盖 repo 与 workspace 核心流程', async () => {
    await git(['init', sourceRepo]);
    await git(['config', 'user.email', 'ello@example.test'], sourceRepo);
    await git(['config', 'user.name', 'Ello Test'], sourceRepo);
    await writeFile(path.join(sourceRepo, 'README.md'), 'hello\n', 'utf8');
    await git(['add', 'README.md'], sourceRepo);
    await git(['commit', '-m', 'init'], sourceRepo);

    const repos = new RepoStore();
    const added = await repos.add('demo', sourceRepo);
    expect(added.key).toBe('demo');
    expect(await repos.rename('demo', 'demo2')).toMatchObject({
      key: 'demo2',
    });
    expect(await repos.show('demo2')).toMatchObject({ key: 'demo2' });

    const storage = createCodingStorage();
    const workspaces = new WorkspaceStore(storage.workspaces, repos);
    const created = await workspaces.create('explore', 'Inspect Demo', [
      'demo2',
    ]);
    expect(created.kind).toBe('explore');
    expect(created.repos[0]?.key).toBe('demo2');
    await expect(
      access(workspaceManifestPath(created.rootPath)),
    ).rejects.toThrow();
    await expect(
      access(workspaceYamlManifestPath(created.rootPath)),
    ).rejects.toThrow();
    expect(await workspaces.open('explore', 'inspect-demo')).toMatchObject({
      kind: 'explore',
      name: 'inspect-demo',
    });
    expect(
      await readFile(
        path.join(created.repos[0]!.path, '.ello', 'workspace.yaml'),
        'utf8',
      ),
    ).toContain('repoKey: demo2');

    await writeFile(
      path.join(created.repos[0]!.path, 'dirty.txt'),
      'dirty\n',
      'utf8',
    );
    await expect(workspaces.remove('explore', 'inspect-demo')).rejects.toThrow(
      'Workspace repo is dirty',
    );
    await expect(
      workspaces.remove('explore', 'inspect-demo', true),
    ).resolves.toBe(true);
    storage.close();
  });
});
