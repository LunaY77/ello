import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import type { RepositoryRepository } from '../storage/repositories/repository-repository.js';
import { parseYamlConfig, stringifyYamlConfig } from '../utils/yaml.js';

import { CommandError, git, gitWithInput } from './git.js';
import { mirrorsDir, repositoryMirrorPath } from './paths.js';
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

export interface FetchResult {
  readonly key: string;
  readonly status: 'fetched' | 'no_remote';
}

/** Git mirror application service；结构化状态只写 SQLite。 */
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
    if (all === keys.length > 0) {
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
      await git(['remote', 'update', '--prune', 'origin'], repo.mirrorPath);
      this.repository.update({
        ...repo,
        defaultBranch: await detectDefaultBranch(repo.mirrorPath),
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
    await git(['fetch', source, '+refs/*:refs/*'], repo.mirrorPath);
    const next = {
      ...repo,
      defaultBranch: await detectDefaultBranch(repo.mirrorPath),
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
    await git(['remote', 'add', 'origin', url], repo.mirrorPath);
    return this.repository.update({
      ...repo,
      remoteUrl: url,
      updatedAt: new Date().toISOString(),
    });
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
    this.assertKeyAvailable(key);
    const { name, email } = await readGitIdentity(identityCwd);
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await mkdir(mirrorsDir(), { recursive: true });
    await git([
      'init',
      '--bare',
      '--initial-branch',
      defaultBranch,
      mirrorPath,
    ]);
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
    await git(
      ['update-ref', `refs/heads/${defaultBranch}`, commit],
      mirrorPath,
    );
    await git(
      ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`],
      mirrorPath,
    );
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
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await mkdir(mirrorsDir(), { recursive: true });
    await git(['clone', '--mirror', source, mirrorPath]);
    await git(['remote', 'remove', 'origin'], mirrorPath);
    return this.insertImported(id, key, mirrorPath, null);
  }

  private async importRemote(
    url: string,
    key: string,
    expectedDefaultBranch?: string,
  ): Promise<Repository> {
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await mkdir(mirrorsDir(), { recursive: true });
    await git(['clone', '--mirror', url, mirrorPath]);
    return this.insertImported(id, key, mirrorPath, url, expectedDefaultBranch);
  }

  private async importBundle(
    bundlePath: string,
    key: string,
    expectedDefaultBranch: string,
  ): Promise<Repository> {
    const id = randomUUID();
    const mirrorPath = repositoryMirrorPath(id);
    await access(bundlePath);
    await mkdir(mirrorsDir(), { recursive: true });
    await git(['clone', '--mirror', bundlePath, mirrorPath]);
    await git(['remote', 'remove', 'origin'], mirrorPath);
    await git(
      ['symbolic-ref', 'HEAD', `refs/heads/${expectedDefaultBranch}`],
      mirrorPath,
    );
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
    expectedDefaultBranch?: string,
  ): Promise<Repository> {
    const defaultBranch = await detectDefaultBranch(mirrorPath);
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
