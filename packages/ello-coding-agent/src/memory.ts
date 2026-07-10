import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { globalHomeDir } from './config/index.js';
export type MemoryScope = 'project' | 'user';

export interface MemoryFile {
  scope: MemoryScope;
  path: string;
  content: string;
}

export interface MemoryManifest {
  files: MemoryFile[];
}

/**
 * 加载会影响当前会话的项目级和用户级记忆文件。
 */
export async function loadCodingMemory(cwd: string): Promise<MemoryManifest> {
  const home = globalHomeDir();
  const candidates = [
    { scope: 'project' as const, path: path.join(cwd, 'AGENTS.md') },
    { scope: 'project' as const, path: path.join(cwd, 'CLAUDE.md') },
    {
      scope: 'project' as const,
      path: path.join(cwd, '.ello', 'instructions.md'),
    },
    { scope: 'project' as const, path: path.join(cwd, '.ello', 'memory.md') },
    {
      scope: 'user' as const,
      path: path.join(home, 'memory.md'),
    },
  ];
  const userMemoryDir = path.join(home, 'memory');
  for (const file of await listMarkdownFiles(userMemoryDir)) {
    candidates.push({ scope: 'user', path: file });
  }

  const seen = new Set<string>();
  const files: MemoryFile[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    try {
      const content = (await readFile(resolved, 'utf8')).trim();
      if (content) {
        files.push({ scope: candidate.scope, path: resolved, content });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return { files };
}

/**
 * 将已加载的记忆文件渲染为可注入 prompt 的 Markdown 块。
 */
export function renderMemoryForPrompt(
  manifest: MemoryManifest,
  cwd: string,
): string {
  const fileSections = manifest.files.map((file) => {
    const displayPath = path.relative(cwd, file.path) || file.path;
    return `# ${displayPath} (${file.scope})\n\n${file.content}`;
  });
  return fileSections.join('\n\n');
}

/**
 * 汇总已加载的记忆来源，供 CLI 和 TUI 状态输出使用。
 */
export function summarizeMemory(manifest: MemoryManifest, cwd: string): string {
  if (manifest.files.length === 0) {
    return 'No memory files loaded.';
  }
  return [
    ...manifest.files.map(
      (file) => `${file.scope}\t${path.relative(cwd, file.path) || file.path}`,
    ),
  ].join('\n');
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
