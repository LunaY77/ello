import { mkdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

import { globalHomeDir } from '../config/index.js';

import { slugify } from './slug.js';
import type { WorkspaceKind } from './types.js';

export function mirrorsDir(): string {
  return path.join(globalHomeDir(), 'mirrors');
}

export function repoRegistryPath(): string {
  return path.join(globalHomeDir(), 'repos.json');
}

export function archiveDir(): string {
  return path.join(globalHomeDir(), 'archive');
}

export function workspacePointerPath(): string {
  return path.join(globalHomeDir(), 'workspaces');
}

export async function resolveWorkspaceRoot(): Promise<string> {
  const pointer = workspacePointerPath();
  try {
    const stat = await lstat(pointer);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      return pointer;
    }
    const text = await readFile(pointer, 'utf8');
    return path.resolve(text.trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    const fallback = path.join(globalHomeDir(), 'workspace-roots');
    await mkdir(fallback, { recursive: true });
    return fallback;
  }
}

export async function workspaceDir(
  kind: WorkspaceKind,
  name: string,
): Promise<string> {
  return path.join(await resolveWorkspaceRoot(), kind, slugify(name));
}

export function workspaceManifestPath(rootPath: string): string {
  return path.join(rootPath, 'workspace.json');
}

export function workspaceYamlManifestPath(rootPath: string): string {
  return path.join(rootPath, 'workspace.yaml');
}
