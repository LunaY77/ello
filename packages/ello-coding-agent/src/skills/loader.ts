import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentSkill } from '@ello/agent';
import { z } from 'zod';

import { parseYamlConfig } from '../utils/yaml.js';

export type SkillSource = NonNullable<AgentSkill['source']>;

const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    'display-name': z.string().min(1).optional(),
    description: z.string().min(1),
    when_to_use: z.string().min(1).optional(),
    'argument-hint': z.string().min(1).optional(),
    'allowed-tools': z.array(z.string().min(1)).optional(),
    context: z.enum(['inline', 'fork']).optional(),
    model: z.string().min(1).optional(),
    effort: z
      .union([z.enum(['low', 'medium', 'high', 'xhigh']), z.number()])
      .optional(),
    'user-invocable': z.boolean().optional(),
    'disable-model-invocation': z.boolean().optional(),
  })
  .strict();

/** 从目录加载严格校验的 `SKILL.md` 技能定义。 */
export async function loadSkillsFromDir(
  dir: string,
  source: SkillSource,
): Promise<AgentSkill[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: AgentSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(dir, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const raw = await readFile(skillPath, 'utf8');
    const parsed = parseSkillMarkdown(raw, skillPath);
    const frontmatter = SkillFrontmatterSchema.parse(parsed.frontmatter);
    skills.push({
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter['display-name'] !== undefined
        ? { displayName: frontmatter['display-name'] }
        : {}),
      ...(frontmatter.when_to_use !== undefined
        ? { whenToUse: frontmatter.when_to_use }
        : {}),
      ...(frontmatter['argument-hint'] !== undefined
        ? { argumentHint: frontmatter['argument-hint'] }
        : {}),
      allowedTools: frontmatter['allowed-tools'] ?? [],
      context: frontmatter.context ?? 'inline',
      ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
      ...(frontmatter.effort !== undefined
        ? { effort: frontmatter.effort }
        : {}),
      userInvocable: frontmatter['user-invocable'] ?? true,
      disableModelInvocation: frontmatter['disable-model-invocation'] ?? false,
      source,
      baseDir: skillDir,
      contentHash: createHash('sha1').update(raw).digest('hex'),
      instructions: parsed.body.trim(),
      metadata: { dir: skillDir, frontmatter },
    });
  }
  return skills;
}

function parseSkillMarkdown(
  raw: string,
  skillPath: string,
): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  if (!raw.startsWith('---\n')) {
    throw new Error(
      `Skill markdown must start with YAML frontmatter: ${skillPath}`,
    );
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error(`Skill markdown frontmatter is not closed: ${skillPath}`);
  }
  const body = raw
    .slice(end + 4)
    .replace(/^\r?\n/u, '')
    .trim();
  if (body === '') {
    throw new Error(`Skill markdown body is empty: ${skillPath}`);
  }
  return {
    frontmatter: parseYamlConfig(raw.slice(4, end)),
    body,
  };
}
