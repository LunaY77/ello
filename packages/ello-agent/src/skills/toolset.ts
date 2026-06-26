import { z } from 'zod';

import type { AgentContext } from '../context.js';
import type { RunContextLike } from '../hooks.js';
import { Toolset, type ToolArgs, type ToolsetTool } from '../toolsets/index.js';

import { loadSkillsFromDir, type SkillConfig } from './config.js';

/** activate_skill 工具参数 schema。 */
export const ActivateSkillArgsSchema = z.object({
  skillName: z.string().describe('Name of the skill to activate.'),
});

/** SkillToolset 构造参数。 */
export interface SkillToolsetOptions {
  skillsDirs: string[];
}

/**
 * 技能工具集。
 *
 * 扫描指定目录的 .md 文件, 提供 activate_skill 工具供 agent 按需加载技能。
 * getInstructions() 会列出可用技能 name + description。
 */
export class SkillToolset extends Toolset {
  private readonly skillsDirs: string[];
  private readonly skills = new Map<string, SkillConfig>();
  private readonly activated = new Set<string>();

  constructor(options: SkillToolsetOptions) {
    super({ tools: [] });
    this.skillsDirs = options.skillsDirs;
  }

  /** 返回所有可用技能名称。 */
  get skillNames(): string[] {
    return [...this.skills.keys()];
  }

  /** 重新加载所有技能目录。 */
  async reloadSkills(): Promise<void> {
    this.skills.clear();
    for (const directory of this.skillsDirs) {
      for (const skill of await loadSkillsFromDir(directory)) {
        this.skills.set(skill.name, skill);
      }
    }
  }

  override async getTools(
    _ctx: RunContextLike<AgentContext>,
  ): Promise<Record<string, ToolsetTool>> {
    if (this.skills.size === 0) {
      await this.reloadSkills();
    }
    if (this.skills.size === 0) {
      return {};
    }
    return {
      activate_skill: {
        name: 'activate_skill',
        description:
          'Activate a skill by name to load its instructions into context.',
        inputSchema: ActivateSkillArgsSchema,
        requiresApproval: false,
        maxRetries: 3,
      },
    };
  }

  override async callTool(
    name: string,
    toolArgs: ToolArgs,
    _ctx: RunContextLike<AgentContext>,
    _tool?: ToolsetTool,
  ): Promise<unknown> {
    if (name !== 'activate_skill') {
      return `Error: tool '${name}' not found`;
    }
    await this.reloadSkills();
    const parsed = ActivateSkillArgsSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return `Error calling tool ${name}: ${parsed.error.message}`;
    }

    const skill = this.skills.get(parsed.data.skillName);
    if (skill === undefined) {
      const available = [...this.skills.keys()].join(', ');
      return `Skill '${parsed.data.skillName}' not found. Available: ${available}`;
    }

    this.activated.add(skill.name);
    return `Skill '${skill.name}' activated.\n\n${skill.body}`;
  }

  override async getInstructions(
    _ctx: RunContextLike<AgentContext>,
  ): Promise<string | null> {
    await this.reloadSkills();
    if (this.skills.size === 0) {
      return null;
    }

    const lines = ['Available skills (use activate_skill to load):'];
    for (const [name, skill] of this.skills) {
      const status = this.activated.has(name) ? ' [active]' : '';
      lines.push(`  - ${name}: ${skill.description}${status}`);
    }
    return lines.join('\n');
  }
}
