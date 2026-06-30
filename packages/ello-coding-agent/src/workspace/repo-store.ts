import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { git } from './git.js';
import { mirrorsDir, repoRegistryPath } from './paths.js';
import { validateRepoKey } from './slug.js';
import type { RepoEntry } from './types.js';

/** repo registry：记录 key/url/mirror，不把 workspace 路径固定死。 */
export class RepoStore {
  async list(): Promise<readonly RepoEntry[]> {
    return Object.values(await this.readRegistry()).sort((a, b) =>
      a.key.localeCompare(b.key),
    );
  }

  async show(key: string): Promise<RepoEntry | null> {
    return (await this.readRegistry())[validateRepoKey(key)] ?? null;
  }

  async add(key: string, url: string): Promise<RepoEntry> {
    const normalized = validateRepoKey(key);
    const registry = await this.readRegistry();
    if (registry[normalized] !== undefined) {
      throw new Error(`Repo already exists: ${normalized}`);
    }
    const mirrorPath = path.join(mirrorsDir(), `${normalized}.git`);
    await mkdir(mirrorsDir(), { recursive: true });
    await git(['init', '--bare', mirrorPath]);
    await git(['remote', 'add', 'origin', url], mirrorPath);
    await git(['fetch', 'origin'], mirrorPath);
    const now = new Date().toISOString();
    const entry: RepoEntry = {
      key: normalized,
      url,
      mirrorPath,
      defaultBranch: await this.detectDefaultBranch(mirrorPath),
      createdAt: now,
      updatedAt: now,
    };
    registry[normalized] = entry;
    await this.writeRegistry(registry);
    return entry;
  }

  async sync(keys?: readonly string[]): Promise<readonly RepoEntry[]> {
    const registry = await this.readRegistry();
    const selected =
      keys === undefined || keys.length === 0
        ? Object.keys(registry)
        : keys.map(validateRepoKey);
    const synced: RepoEntry[] = [];
    for (const key of selected) {
      const entry = registry[key];
      if (entry === undefined) {
        throw new Error(`Unknown repo: ${key}`);
      }
      await git(['fetch', 'origin'], entry.mirrorPath);
      const next = {
        ...entry,
        defaultBranch: await this.detectDefaultBranch(entry.mirrorPath),
        updatedAt: new Date().toISOString(),
      };
      registry[key] = next;
      synced.push(next);
    }
    await this.writeRegistry(registry);
    return synced;
  }

  async remove(key: string): Promise<boolean> {
    const normalized = validateRepoKey(key);
    const registry = await this.readRegistry();
    const entry = registry[normalized];
    if (entry === undefined) {
      return false;
    }
    delete registry[normalized];
    await rm(entry.mirrorPath, { recursive: true, force: true });
    await this.writeRegistry(registry);
    return true;
  }

  async rename(key: string, newKey: string): Promise<RepoEntry> {
    const oldKey = validateRepoKey(key);
    const normalizedNew = validateRepoKey(newKey);
    const registry = await this.readRegistry();
    const entry = registry[oldKey];
    if (entry === undefined) {
      throw new Error(`Unknown repo: ${oldKey}`);
    }
    if (registry[normalizedNew] !== undefined) {
      throw new Error(`Repo already exists: ${normalizedNew}`);
    }
    delete registry[oldKey];
    const next = {
      ...entry,
      key: normalizedNew,
      updatedAt: new Date().toISOString(),
    };
    registry[normalizedNew] = next;
    await this.writeRegistry(registry);
    return next;
  }

  async setUrl(key: string, url: string): Promise<RepoEntry> {
    const normalized = validateRepoKey(key);
    const registry = await this.readRegistry();
    const entry = registry[normalized];
    if (entry === undefined) {
      throw new Error(`Unknown repo: ${normalized}`);
    }
    await git(['remote', 'set-url', 'origin', url], entry.mirrorPath);
    const next = { ...entry, url, updatedAt: new Date().toISOString() };
    registry[normalized] = next;
    await this.writeRegistry(registry);
    return next;
  }

  private async readRegistry(): Promise<Record<string, RepoEntry>> {
    try {
      return JSON.parse(await readFile(repoRegistryPath(), 'utf8')) as Record<
        string,
        RepoEntry
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  private async writeRegistry(
    registry: Record<string, RepoEntry>,
  ): Promise<void> {
    await mkdir(path.dirname(repoRegistryPath()), { recursive: true });
    await writeFile(
      repoRegistryPath(),
      `${JSON.stringify(registry, null, 2)}\n`,
      'utf8',
    );
  }

  private async detectDefaultBranch(
    mirrorPath: string,
  ): Promise<string | undefined> {
    try {
      const ref = await git(
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        mirrorPath,
      );
      return ref.replace(/^origin\//u, '');
    } catch {
      try {
        const refs = await git(
          ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
          mirrorPath,
        );
        return refs
          .split(/\r?\n/u)
          .map((ref) => ref.replace(/^origin\//u, ''))
          .find((ref) => ref !== '' && ref !== 'HEAD');
      } catch {
        return undefined;
      }
    }
  }
}
