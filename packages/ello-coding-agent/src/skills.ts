import { loadSkillsFromDir, type AgentSkill } from '@ello/agent';

import type { CodingAgentConfig } from './config.js';
import { globalSkillsDir, projectSkillsDir } from './session/paths.js';

/**
 * 加载 coding-agent 可用技能。
 *
 * 全局 `~/.ello/skills` 与项目 `<cwd>/.ello/skills` 各自是“一个子目录 = 一个技能
 * （内含 SKILL.md）”的布局，加载机制完全复用内核 {@link loadSkillsFromDir}，
 * 本函数只做目录装配与同名覆盖。
 *
 * 覆盖规则：先全局后项目，**项目同名技能覆盖全局**（与 07/08 的覆盖规则一致）。
 */
export async function loadCodingSkills(config: CodingAgentConfig): Promise<AgentSkill[]> {
  const global = await safeLoad(globalSkillsDir());
  const project = await safeLoad(projectSkillsDir(config.cwd));
  return dedupeByName([...global, ...project]);
}

/** 加载某目录下的技能；目录不存在时返回空数组。 */
async function safeLoad(dir: string): Promise<AgentSkill[]> {
  try {
    return await loadSkillsFromDir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** 按 name 去重，后者覆盖前者（项目覆盖全局）。 */
function dedupeByName(skills: readonly AgentSkill[]): AgentSkill[] {
  const byName = new Map<string, AgentSkill>();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()];
}
