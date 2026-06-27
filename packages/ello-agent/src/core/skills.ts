import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { defineTool } from '../public/tool.js';
import type {
  AgentSkill,
  AnyAgentTool,
  ContextBundle,
  ContextSource,
} from '../public/types.js';

export interface ActiveSkillsContextOptions {
  readonly skills: readonly AgentSkill[];
  readonly activation?: 'always-on' | 'activated';
}

export function activeSkillsContext(
  options: ActiveSkillsContextOptions,
): ContextSource {
  const active = new Set<string>();
  return {
    name: 'agent.skills',
    load() {
      const selected =
        options.activation === 'always-on'
          ? options.skills
          : options.skills.filter((skill) => active.has(skill.name));
      return selected.map((skill) => {
        const bundle: ContextBundle = {
          kind: 'system',
          source: `skill.${skill.name}`,
          priority: 700,
          scope: 'session',
          retention: 'compressible',
          persist: 'session',
          text: `<skill name="${skill.name}">\n${skill.instructions}\n</skill>`,
          ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
        };
        return bundle;
      });
    },
  };
}

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
