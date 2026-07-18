import type { WorkspaceKind } from './types.js';

/** 校验 repo key，避免路径穿越和难读 manifest。 */
export function validateRepoKey(value: string): string {
  const segments = value.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !/^[a-zA-Z0-9._-]+$/u.test(segment),
    )
  ) {
    throw new Error(`Invalid repo key: ${value}`);
  }
  return value;
}

/** 校验 workspace 类型。 */
export function validateKind(value: string): WorkspaceKind {
  if (
    value === 'feature' ||
    value === 'fix' ||
    value === 'refactor' ||
    value === 'explore'
  ) {
    return value;
  }
  throw new Error(`Invalid workspace kind: ${value}`);
}

/** 把用户输入转换成可作为目录名和分支名的 slug。 */
export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (slug === '') {
    throw new Error('Workspace name cannot be empty.');
  }
  return slug;
}
