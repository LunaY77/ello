import { homedir } from 'node:os';
import path from 'node:path';

import { globalHomeDir } from '../config/index.js';

import { slugify } from './slug.js';
import type { WorkspaceKind } from './types.js';

export function mirrorsDir(): string {
  return path.join(globalHomeDir(), 'mirrors');
}

export function repositoryMirrorPath(repositoryId: string): string {
  return path.join(mirrorsDir(), `${repositoryId}.git`);
}

export function resolveWorkspaceMount(
  configuredMount: string,
): string {
  const expanded =
    configuredMount === '~'
      ? homedir()
      : configuredMount.startsWith('~/')
        ? path.join(homedir(), configuredMount.slice(2))
        : configuredMount;
  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `Workspace mount must be an absolute path: ${configuredMount}`,
    );
  }
  return path.resolve(expanded);
}

export function activeWorkspacesDir(mount: string): string {
  return path.join(mount, 'workspace');
}

export function archivedWorkspacesDir(mount: string): string {
  return path.join(mount, 'archive');
}

export function workspaceDir(
  mount: string,
  kind: WorkspaceKind,
  name: string,
): string {
  return path.join(activeWorkspacesDir(mount), kind, slugify(name));
}

export function archivedWorkspaceDir(
  mount: string,
  kind: WorkspaceKind,
  name: string,
  workspaceId: string,
  archivedAt: string,
): string {
  const timestamp = archivedAt.replace(/[-:.]/gu, '');
  return path.join(
    archivedWorkspacesDir(mount),
    kind,
    `${slugify(name)}-${timestamp}-${workspaceId}`,
  );
}
