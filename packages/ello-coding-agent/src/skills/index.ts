import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentSkill } from '@ello/agent';

import type { CodingAgentConfig } from '../config/index.js';
import { globalSkillsDir, projectSkillsDir } from '../session/paths.js';

import { loadSkillsFromDir } from './loader.js';

function bundledSkillsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundled');
}

/**
 * 加载 coding-agent 可用技能。
 *
 * 技能目录遵循 Codex/YAACLI 风格：一个子目录就是一个技能，目录内必须有
 * `SKILL.md`。内置、全局、项目技能走同一套 loader，避免内置技能变成硬编码
 * prompt。覆盖规则按优先级从低到高排列：bundled < global < project。
 */
export async function loadCodingSkills(
  config: CodingAgentConfig,
): Promise<AgentSkill[]> {
  const bundled = await loadSkillsFromDir(bundledSkillsDir(), 'bundled');
  const global = await safeLoad(globalSkillsDir(), 'global');
  const project = await safeLoad(projectSkillsDir(config.cwd), 'project');
  return dedupeByName([...bundled, ...global, ...project]);
}

async function safeLoad(
  dir: string,
  source: NonNullable<AgentSkill['source']>,
): Promise<AgentSkill[]> {
  try {
    return await loadSkillsFromDir(dir, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function dedupeByName(skills: readonly AgentSkill[]): AgentSkill[] {
  const byName = new Map<string, AgentSkill>();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

export function formatSkillList(skills: readonly AgentSkill[]): string {
  if (skills.length === 0) {
    return 'skills\t<none>';
  }
  return skills
    .map(
      (skill) =>
        `${skill.name}\t${skill.source ?? 'global'}\t${skill.context ?? 'inline'}\t${skill.description}`,
    )
    .join('\n');
}

export function formatSkill(skill: AgentSkill): string {
  return [
    `name\t${skill.name}`,
    `source\t${skill.source ?? 'global'}`,
    `context\t${skill.context ?? 'inline'}`,
    `description\t${skill.description}`,
    `whenToUse\t${skill.whenToUse ?? '<none>'}`,
    `allowedTools\t${skill.allowedTools?.join(', ') || '<none>'}`,
    `baseDir\t${skill.baseDir ?? '<bundled>'}`,
  ].join('\n');
}
