import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const STORAGE_ID_PATTERN = /^[A-Za-z0-9_@+-][A-Za-z0-9._:@+-]{0,199}$/u;

export function elloHomeDir(): string {
  const configured = process.env.ELLO_HOME?.trim();
  return configured === undefined || configured === ''
    ? join(homedir(), '.ello')
    : configured;
}

export function activeThreadsDir(root = elloHomeDir()): string {
  return join(root, 'threads', 'active');
}

export function archivedThreadsDir(root = elloHomeDir()): string {
  return join(root, 'threads', 'archived');
}

export function threadLogPath(threadId: string, root = elloHomeDir()): string {
  return storageFilePath(activeThreadsDir(root), threadId, '.jsonl');
}

export function archivedThreadLogPath(
  threadId: string,
  root = elloHomeDir(),
): string {
  return storageFilePath(archivedThreadsDir(root), threadId, '.jsonl');
}

export function artifactsDir(root = elloHomeDir()): string {
  return join(root, 'artifacts');
}

export function stateDatabasePath(root = elloHomeDir()): string {
  return join(root, 'state', 'ello.sqlite');
}

/** 数据库目录重构前的全局 state.sqlite，供首次启动时只读迁移。 */
export function legacyStateDatabasePath(root = elloHomeDir()): string {
  return join(root, 'state.sqlite');
}

export function serverRunDir(root = elloHomeDir()): string {
  return join(root, 'run');
}

export function threadLocksDir(root = elloHomeDir()): string {
  return join(serverRunDir(root), 'thread-locks');
}

export function threadLeasePath(
  threadId: string,
  root = elloHomeDir(),
): string {
  return storageFilePath(threadLocksDir(root), threadId, '.lock');
}

/** 文件型 thread ID 不接受目录分隔符，并再次验证结果仍位于目标目录。 */
function storageFilePath(
  directory: string,
  id: string,
  extension: string,
): string {
  if (!STORAGE_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new Error(`Unsafe storage id: ${id}.`);
  }
  const base = resolve(directory);
  const candidate = resolve(base, `${id}${extension}`);
  const relativeCandidate = relative(base, candidate);
  if (
    relativeCandidate === '' ||
    relativeCandidate === '..' ||
    relativeCandidate.startsWith(`..${sep}`) ||
    isAbsolute(relativeCandidate)
  ) {
    throw new Error(`Storage path escapes its directory: ${id}.`);
  }
  return candidate;
}
