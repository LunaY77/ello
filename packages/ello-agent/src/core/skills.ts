/**
 * 技能（skill）相关支撑模块。
 *
 * 技能是一段命名的指令文本（可附带专属工具），用于按需为模型注入领域能力。
 * 本模块提供三件事：把激活中的技能拼成系统提示片段、生成 `skill_*`
 * 工具及技能自带工具集合。
 */

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
  /** 与 skill tools 共享的激活集合。 */
  readonly active?: Set<string>;
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
  const active = options.active ?? new Set<string>();
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
 * 返回的列表包含 `skill_list/get/search/invoke/activate/deactivate` 工具，
 * 以及所有技能自带的专属工具。`active` 集合在内外共享，因此激活动作会同步影响
 * {@link activeSkillsContext} 的注入决策。
 */
export function createSkillTools(options: {
  readonly skills: readonly AgentSkill[];
  readonly active?: Set<string>;
}): AnyAgentTool[] {
  const active = options.active ?? new Set<string>();
  const list = defineTool({
    name: 'skill_list',
    description: 'List available skills without loading full references.',
    input: z.object({}),
    execute: () => options.skills.map(skillSummary),
  });
  const get = defineTool({
    name: 'skill_get',
    description: 'Read one skill definition and metadata.',
    input: z.object({ name: z.string() }),
    execute: ({ name }) => requireSkill(options.skills, name),
  });
  const search = defineTool({
    name: 'skill_search',
    description: 'Search skills by name, description, and whenToUse.',
    input: z.object({ query: z.string() }),
    execute: ({ query }) => {
      const normalized = query.toLowerCase();
      return options.skills
        .filter((skill) =>
          [skill.name, skill.description, skill.whenToUse ?? '']
            .join('\n')
            .toLowerCase()
            .includes(normalized),
        )
        .map(skillSummary);
    },
  });
  const invoke = defineTool({
    name: 'skill_invoke',
    description: 'Invoke a skill inline or report fork invocation metadata.',
    input: z.object({ name: z.string(), args: z.string().optional() }),
    execute: ({ name, args }) => {
      const skill = requireSkill(options.skills, name);
      active.add(name);
      return {
        invoked: name,
        context: skill.context ?? 'inline',
        args: args ?? '',
        newMessages:
          (skill.context ?? 'inline') === 'inline'
            ? [
                {
                  role: 'system',
                  content: renderSkillInvocation(skill, args),
                },
              ]
            : [],
      };
    },
  });
  const activate = defineTool({
    name: 'skill_activate',
    description: 'Activate a named skill for later turns.',
    input: z.object({ name: z.string() }),
    execute: ({ name }) => {
      requireSkill(options.skills, name);
      active.add(name);
      return { activated: name };
    },
  });
  const deactivate = defineTool({
    name: 'skill_deactivate',
    description: 'Deactivate a named skill for later turns.',
    input: z.object({ name: z.string() }),
    execute: ({ name }) => {
      active.delete(name);
      return { deactivated: name };
    },
  });
  return [
    list as AnyAgentTool,
    get as AnyAgentTool,
    search as AnyAgentTool,
    invoke as AnyAgentTool,
    activate as AnyAgentTool,
    deactivate as AnyAgentTool,
    ...options.skills.flatMap((skill) => skill.tools ?? []),
  ];
}

/** 系统提示里的技能索引，按 1% 上下文窗口预算截断。 */
export function skillIndexContext(options: {
  readonly skills: readonly AgentSkill[];
  readonly contextWindow?: number;
}): SystemSection {
  return () => {
    if (options.skills.length === 0) {
      return null;
    }
    const budget = Math.max(
      400,
      Math.floor((options.contextWindow ?? 160_000) * 4 * 0.01),
    );
    const lines = ['<skills-context>'];
    for (const skill of options.skills) {
      const line = `- ${skill.name}: ${skill.description}${skill.whenToUse ? ` (${skill.whenToUse})` : ''}`;
      if ([...lines, line].join('\n').length > budget) {
        lines.push(`- ${skill.name}`);
      } else {
        lines.push(line);
      }
    }
    lines.push('</skills-context>');
    return lines.join('\n');
  };
}

function requireSkill(skills: readonly AgentSkill[], name: string): AgentSkill {
  const skill = skills.find((item) => item.name === name);
  if (skill === undefined) {
    throw new Error(`Unknown skill: ${name}`);
  }
  return skill;
}

function skillSummary(skill: AgentSkill): Record<string, unknown> {
  return {
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    whenToUse: skill.whenToUse,
    allowedTools: skill.allowedTools ?? [],
    context: skill.context ?? 'inline',
    source: skill.source ?? 'global',
  };
}

function renderSkillInvocation(
  skill: AgentSkill,
  args: string | undefined,
): string {
  return [
    `<skill name="${skill.name}">`,
    args !== undefined && args.trim() !== '' ? `<args>${args}</args>` : null,
    skill.instructions,
    '</skill>',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
