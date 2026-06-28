/**
 * 技能（skill）相关支撑模块。
 *
 * 技能是一段命名的指令文本（可附带专属工具），用于按需为模型注入领域能力。
 * 本模块提供三件事：把激活中的技能拼成系统提示片段、生成 `activate_skill`
 * 工具及技能自带工具集合，以及从磁盘目录加载技能定义。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { defineTool } from '../public/tool.js';
import type {
  AgentSkill,
  AnyAgentTool,
  SystemSection,
} from '../public/types.js';

/** {@link activeSkillsContext} 的入参。 */
export interface ActiveSkillsContextOptions {
  /** 全部可用技能。 */
  readonly skills: readonly AgentSkill[];
  /** 激活模式：`always-on` 全部常驻注入，`activated`（默认）仅注入已激活者。 */
  readonly activation?: 'always-on' | 'activated';
}

/**
 * 生成一个动态系统提示片段，按激活模式把相关技能的指令拼入系统提示。
 *
 * 返回的是一个惰性 {@link SystemSection}，每次构建提示时即时计算当前应注入哪些
 * 技能；无可注入技能时返回 `null`，使该片段被略过。
 */
export function activeSkillsContext(
  options: ActiveSkillsContextOptions,
): SystemSection {
  const active = new Set<string>();
  return () => {
    // always-on：注入全部技能；否则只注入名字在激活集合中的技能。
    const selected =
      options.activation === 'always-on'
        ? options.skills
        : options.skills.filter((skill) => active.has(skill.name));
    if (selected.length === 0) {
      return null;
    }
    // 每个技能包成带名字的 <skill> 标签，便于模型区分各段指令归属。
    return selected
      .map(
        (skill) =>
          `<skill name="${skill.name}">\n${skill.instructions}\n</skill>`,
      )
      .join('\n\n');
  };
}

/**
 * 构造技能相关工具集合。
 *
 * 返回的列表包含一个 `activate_skill` 工具（供模型显式激活某技能，使其指令在
 * 后续回合被注入），以及所有技能自带的专属工具。`active` 集合在内外共享，因此
 * 激活动作会同步影响 {@link activeSkillsContext} 的注入决策。
 */
export function createSkillTools(options: {
  readonly skills: readonly AgentSkill[];
  readonly active?: Set<string>;
}): AnyAgentTool[] {
  const active = options.active ?? new Set<string>();
  const activateSkill = defineTool({
    name: 'activate_skill',
    description: 'Activate a named skill for later turns.',
    input: z.object({ name: z.string() }),
    execute: ({ name }) => {
      // 拒绝激活不存在的技能，避免静默地激活一个空名字。
      const skill = options.skills.find((item) => item.name === name);
      if (skill === undefined) {
        throw new Error(`Unknown skill: ${name}`);
      }
      active.add(name);
      return { activated: name };
    },
  });
  return [
    activateSkill as AnyAgentTool,
    ...options.skills.flatMap((skill) => skill.tools ?? []),
  ];
}

/**
 * 从一个目录加载技能：每个子目录即一个技能，其 `SKILL.md` 为指令正文。
 *
 * 技能名取自子目录名，描述取自 Markdown 的首个一级标题（缺省回退为目录名），
 * 并在元数据里记录技能所在目录。非目录项一律跳过。
 */
export async function loadSkillsFromDir(dir: string): Promise<AgentSkill[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: AgentSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(dir, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const instructions = await readFile(skillPath, 'utf8');
    // 用首个 `# 标题` 作为简短描述，找不到则退回目录名。
    const firstHeading =
      instructions.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? entry.name;
    skills.push({
      name: entry.name,
      description: firstHeading,
      instructions,
      metadata: { dir: skillDir },
    });
  }
  return skills;
}
