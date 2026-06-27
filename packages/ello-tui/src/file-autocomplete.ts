import { readdir } from 'node:fs/promises';
import path from 'node:path';

export interface FileSuggestion {
  label: string;
  replacement: string;
  isDirectory: boolean;
}

interface FileReferenceToken {
  start: number;
  end: number;
  raw: string;
  query: string;
}

/**
 * 为 composer 中当前活跃的 `@path` token 返回文件建议。
 */
export async function suggestFileReferences(
  value: string,
  cwd: string,
  limit = 8,
): Promise<FileSuggestion[]> {
  const token = findActiveFileReference(value);
  if (token === null) {
    return [];
  }
  const normalizedQuery = token.query.replace(/^~(?=$|\/)/, '');
  const queryDir = path.dirname(normalizedQuery);
  const hasDir = queryDir !== '.';
  const baseName = path.basename(normalizedQuery);
  const searchDir = path.resolve(cwd, hasDir ? queryDir : '.');
  let entries;
  try {
    entries = await readdir(searchDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.name.startsWith(baseName))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, limit)
    .map((entry) => {
      const relativePath = hasDir ? path.join(queryDir, entry.name) : entry.name;
      const replacement = `@${relativePath}${entry.isDirectory() ? '/' : ''}`;
      return {
        label: `${entry.isDirectory() ? 'dir' : 'file'} ${replacement}`,
        replacement,
        isDirectory: entry.isDirectory(),
      };
    });
}

/**
 * 用选中的建议替换当前活跃的 `@path` token。
 */
export function applyFileSuggestion(value: string, suggestion: FileSuggestion): string {
  const token = findActiveFileReference(value);
  if (token === null) {
    return value;
  }
  return `${value.slice(0, token.start)}${suggestion.replacement}${value.slice(token.end)}`;
}

/**
 * 检测 composer 缓冲区末尾活跃的文件引用 token。
 */
export function findActiveFileReference(value: string): FileReferenceToken | null {
  const match = /(^|\s)(@[^\s]*)$/.exec(value);
  if (match === null) {
    return null;
  }
  const raw = match[2] ?? '';
  return {
    start: match.index + (match[1]?.length ?? 0),
    end: value.length,
    raw,
    query: raw.slice(1),
  };
}
