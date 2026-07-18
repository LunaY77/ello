import { lstat } from 'node:fs/promises';

import type { AgentSkill } from '@ello/agent';

import {
  globalSkillsDir,
  projectSkillsDir,
  type CodingAgentConfig,
} from '../config/index.js';

import { loadSkillsFromDir } from './loader.js';
import { SkillSearchIndex } from './search-index.js';

export class SkillCatalog {
  private snapshot: readonly AgentSkill[] = [];
  private searchIndex = new SkillSearchIndex([]);

  constructor(private readonly config: CodingAgentConfig) {}

  async initialize(): Promise<readonly AgentSkill[]> {
    return this.reload();
  }

  list(): readonly AgentSkill[] {
    return this.snapshot;
  }

  get(name: string): AgentSkill | undefined {
    return this.snapshot.find((skill) => skill.name === name);
  }

  search(query: string): readonly AgentSkill[] {
    return this.searchIndex.search(query, 8).map((result) => result.skill);
  }

  async reload(): Promise<readonly AgentSkill[]> {
    // buildCatalog 完成全部 IO/schema 校验后才替换快照，失败时保留上一份可用结果。
    const next = await buildCatalog(this.config);
    this.snapshot = Object.freeze(next);
    this.searchIndex = new SkillSearchIndex(this.snapshot);
    return this.snapshot;
  }
}

export async function loadCodingSkills(
  config: CodingAgentConfig,
): Promise<AgentSkill[]> {
  return buildCatalog(config);
}

export async function searchCodingSkills(
  config: CodingAgentConfig,
  query: string,
): Promise<readonly AgentSkill[]> {
  const catalog = new SkillCatalog(config);
  await catalog.initialize();
  return catalog.search(query);
}

async function buildCatalog(config: CodingAgentConfig): Promise<AgentSkill[]> {
  // Global 是初始化流程创建的必需来源；Project 根不存在代表项目没有覆盖项。
  const global = await loadSkillsFromDir(globalSkillsDir(), 'global');
  const projectDir = projectSkillsDir(config.cwd);
  const project = (await exists(projectDir))
    ? await loadSkillsFromDir(projectDir, 'project')
    : [];
  const byName = new Map<string, AgentSkill>();
  for (const skill of [...global, ...project]) byName.set(skill.name, skill);
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function formatSkillList(skills: readonly AgentSkill[]): string {
  if (skills.length === 0) return 'skills\t<none>';
  return skills
    .map(
      (skill) =>
        `${skill.name}\t${skill.source}\t${skill.description}\t${skill.skillPath}`,
    )
    .join('\n');
}

export function formatSkill(skill: AgentSkill): string {
  return [
    `name\t${skill.name}`,
    `source\t${skill.source}`,
    `description\t${skill.description}`,
    `baseDir\t${skill.baseDir}`,
    `realPath\t${skill.realPath}`,
  ].join('\n');
}
