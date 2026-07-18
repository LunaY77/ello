/**
 * 技能（skill）相关支撑模块。
 *
 * 技能是一段命名的指令文本，用于按需为模型注入领域能力。
 * 本模块只负责生成稳定的轻量技能索引。技能正文只能由 activate_skill 工具结果
 * 加载，不能通过晚到的 system prompt 片段注入。
 */

import type { AgentSkill, SystemSection } from '../public/types.js';

/** 系统提示里的技能索引，按 1% 上下文窗口预算截断。 */
export function skillIndexContext(options: {
  readonly skills: readonly AgentSkill[];
  readonly contextWindow?: number;
}): SystemSection {
  return () => {
    const indexed = options.skills;
    if (indexed.length === 0) {
      return null;
    }
    const budget = Math.max(
      400,
      Math.floor((options.contextWindow ?? 160_000) * 4 * 0.01),
    );
    const lines = ['<skills-context>'];
    for (const skill of indexed) {
      const line = `- ${skill.name}: ${skill.description}`;
      if ([...lines, line].join('\n').length > budget) {
        lines.push(`- ${skill.name}`);
      } else {
        lines.push(line);
      }
    }
    lines.push('</skills-context>');
    lines.push(
      'Use activate_skill before responding when one of these skills applies.',
      'When the user starts a message with $<skill-name>, treat it as an explicit request to call activate_skill with that exact name and pass the remaining text as arguments.',
      'Do not read SKILL.md directly as a substitute for activation.',
      'Do not call a skill again when an activated_skill result for the same name already appears after the latest user message.',
    );
    return lines.join('\n');
  };
}
