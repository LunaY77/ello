import { homedir } from 'node:os';
import { join } from 'node:path';

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
  return join(activeThreadsDir(root), `${threadId}.jsonl`);
}

export function archivedThreadLogPath(
  threadId: string,
  root = elloHomeDir(),
): string {
  return join(archivedThreadsDir(root), `${threadId}.jsonl`);
}

export function artifactsDir(root = elloHomeDir()): string {
  return join(root, 'artifacts');
}

export function stateDatabasePath(root = elloHomeDir()): string {
  return join(root, 'state', 'ello.sqlite');
}

export function serverRunDir(root = elloHomeDir()): string {
  return join(root, 'run');
}
