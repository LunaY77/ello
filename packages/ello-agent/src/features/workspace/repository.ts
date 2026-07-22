/**
 * Workspace 领域的 Repository 数据契约与 key 校验集中在本文件。
 *
 * `Repository` 描述 SQLite 与 Git mirror 共同维护的仓库身份；导入文档先由 Zod schema 校验，
 * Workspace checkout、repository registry 与 mirror 操作共享这些类型和校验能力。
 */
import { z } from 'zod';

export interface Repository {
  readonly id: string;
  readonly key: string;
  readonly mirrorPath: string;
  readonly remoteUrl: string | null;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const RepoExportDocumentSchema = z.object({
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

export type RepoExportDocument = z.infer<typeof RepoExportDocumentSchema>;

/**
 * 校验用户提供的 Repo key，阻止空 segment、路径穿越和不可读字符进入 mirror 或 manifest。
 *
 * Args:
 * - `value`: 用户输入或导入文档中的仓库 key；函数不修改原字符串。
 *
 * Returns:
 * - 返回已验证且可安全作为分层相对路径使用的原 key。
 *
 * Throws:
 * - 当任一 segment 为空、为点路径或包含允许集合外字符时抛错。
 */
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
