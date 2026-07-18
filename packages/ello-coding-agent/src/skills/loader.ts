import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentSkill } from '@ello/agent';
import { z } from 'zod';

import { parseYamlConfig } from '../utils/yaml.js';

export type SkillSource = AgentSkill['source'];

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().regex(KEBAB_CASE, 'must be kebab-case'),
    description: z.string().min(1).max(1024),
  })
  .strict();

export const MAX_SKILL_BODY_BYTES = 64 * 1024;

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
