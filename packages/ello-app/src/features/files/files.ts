/**
 * 文件面板的本地缓存:目录列表与文件内容按 cwd+path 缓存。
 * 这是易失性视图缓存,不是 Server 投影 —— 刷新直接重读 RPC。
 */
import type { ClientResult } from '@ello/agent/protocol';
import { create } from 'zustand';

import { getAppClient } from '@/client/session';

export type DirectoryEntry = ClientResult<'fs/readDirectory'>['data'][number];

interface FilesCacheState {
  readonly directories: Readonly<Record<string, readonly DirectoryEntry[]>>;
  readonly files: Readonly<Record<string, string>>;
  setDirectory: (key: string, entries: readonly DirectoryEntry[]) => void;
  setFile: (key: string, content: string) => void;
}

export const useFilesCache = create<FilesCacheState>()((set) => ({
  directories: {},
  files: {},
  setDirectory: (key, entries) =>
    set((state) => ({ directories: { ...state.directories, [key]: entries } })),
  setFile: (key, content) =>
    set((state) => ({ files: { ...state.files, [key]: content } })),
}));

export function filesCacheKey(cwd: string, path: string): string {
  return `${cwd}\n${path}`;
}

/** 读取目录(带缓存);force 时重读。 */
export async function loadDirectory(
  cwd: string,
  path: string,
  force = false,
): Promise<readonly DirectoryEntry[]> {
  const key = filesCacheKey(cwd, path);
  const cached = useFilesCache.getState().directories[key];
  if (cached !== undefined && !force) return cached;
  const result = await getAppClient().request('fs/readDirectory', { cwd, path });
  const sorted = [...result.data].sort((a, b) => {
    if ((a.kind === 'directory') !== (b.kind === 'directory')) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  useFilesCache.getState().setDirectory(key, sorted);
  return sorted;
}

/** 读取文件内容(带缓存)。 */
export async function loadFileContent(cwd: string, path: string): Promise<string> {
  const key = filesCacheKey(cwd, path);
  const cached = useFilesCache.getState().files[key];
  if (cached !== undefined) return cached;
  const result = await getAppClient().request('fs/readFile', { cwd, path });
  useFilesCache.getState().setFile(key, result.content);
  return result.content;
}

/** 使某路径相关的缓存失效:变更文件的父目录链与文件内容。 */
export function invalidatePath(cwd: string, path: string): void {
  useFilesCache.setState((state) => {
    const prefix = `${cwd}\n`;
    const directories = Object.fromEntries(
      Object.entries(state.directories).filter(([key]) => {
        const dirPath = key.slice(prefix.length);
        const isParent =
          dirPath === path ||
          (dirPath === '.' ? true : path.startsWith(`${dirPath}/`));
        return !isParent;
      }),
    );
    const files = { ...state.files };
    delete files[filesCacheKey(cwd, path)];
    return { directories, files };
  });
}
