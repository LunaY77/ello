/**
 * 本文件负责 skill feature 的“loader”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { AgentSkill } from '../../agent/engine/index.js';
import { parseYamlConfig } from '../../config/index.js';

export type SkillSource = AgentSkill['source'];

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().regex(KEBAB_CASE, 'must be kebab-case'),
    description: z.string().min(1).max(1024),
  })
  .strict();

export const MAX_SKILL_BODY_BYTES = 64 * 1024;

/**
 * 读取 Skill `loader` 模块 的 `loadSkillsFromDir` 视图，不转移底层状态所有权。
 *
 * Args:
 * - `dir`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `source`: `loadSkillsFromDir` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 Skill `loader` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 Skill `loader` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function loadSkillsFromDir(
  dir: string,
  source: SkillSource,
): Promise<AgentSkill[]> {
  // 先按用户看到的链接名排序；真实路径只用于安全校验和去重，不能改变展示顺序。
  const entries = (await readdir(dir, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const skills: AgentSkill[] = [];
  const realPaths = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const linkPath = path.join(dir, entry.name);
    let canonical: string;
    try {
      // realpath 会同时暴露断链、循环链接和不存在的目标，错误保留 linkPath 便于修复。
      canonical = await realpath(linkPath);
      if (!(await stat(canonical)).isDirectory()) {
        throw new Error('target is not a directory');
      }
    } catch (error) {
      throw skillError(
        linkPath,
        `invalid or broken skill link: ${message(error)}`,
      );
    }
    const duplicate = realPaths.get(canonical);
    if (duplicate !== undefined) {
      // 同一个真实目录只能出现一次，否则覆盖优先级会依赖目录遍历顺序。
      throw skillError(
        linkPath,
        `duplicate real path ${canonical}; already loaded from ${duplicate}`,
      );
    }
    realPaths.set(canonical, linkPath);

    const skillPath = path.join(linkPath, 'SKILL.md');
    let raw: string;
    try {
      raw = await readFile(skillPath, 'utf8');
    } catch (error) {
      throw skillError(skillPath, message(error));
    }
    const parsed = parseSkillMarkdown(raw, skillPath);
    let frontmatter: z.infer<typeof SkillFrontmatterSchema>;
    try {
      frontmatter = SkillFrontmatterSchema.parse(parsed.frontmatter);
    } catch (error) {
      throw skillError(skillPath, message(error));
    }
    if (frontmatter.name !== entry.name) {
      throw skillError(
        skillPath,
        `frontmatter name "${frontmatter.name}" does not match directory "${entry.name}"`,
      );
    }
    const normalizedRaw = raw.replace(/\r\n/gu, '\n');
    skills.push({
      name: frontmatter.name,
      description: frontmatter.description,
      source,
      baseDir: linkPath,
      realPath: canonical,
      skillPath,
      contentHash: createHash('sha256').update(normalizedRaw).digest('hex'),
      instructions: parsed.body,
      metadata: { linkPath, realPath: canonical, frontmatter },
    });
  }
  return skills;
}

/**
 * 校验 Skill `loader` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `raw`: `parseSkillMarkdown` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `skillPath`: `parseSkillMarkdown` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `parseSkillMarkdown` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Skill `loader` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseSkillMarkdown(
  raw: string,
  skillPath: string,
): { readonly frontmatter: Record<string, unknown>; readonly body: string } {
  const normalized = raw.replace(/\r\n/gu, '\n');
  if (!normalized.startsWith('---\n')) {
    throw skillError(skillPath, 'must start with YAML frontmatter');
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    throw skillError(skillPath, 'frontmatter is not closed');
  }
  const body = normalized.slice(end + 5).trim();
  if (body === '') throw skillError(skillPath, 'body is empty');
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > MAX_SKILL_BODY_BYTES) {
    throw skillError(
      skillPath,
      `body is ${bodyBytes} bytes, exceeding ${MAX_SKILL_BODY_BYTES}`,
    );
  }
  try {
    return { frontmatter: parseYamlConfig(normalized.slice(4, end)), body };
  } catch (error) {
    throw skillError(skillPath, `invalid YAML: ${message(error)}`);
  }
}

function skillError(skillPath: string, detail: string): Error {
  return new Error(`Invalid skill at ${skillPath}: ${detail}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
