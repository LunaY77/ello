/**
 * 本文件负责 skill feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { lstat } from 'node:fs/promises';

import { errnoCode } from '../../../infra/filesystem.js';
import type { AgentSkill } from '../../agent/engine/index.js';
import {
  globalSkillsDir,
  projectSkillsDir,
  type CodingAgentConfig,
} from '../../config/index.js';

import { loadSkillsFromDir } from './loader.js';
import { SkillSearchIndex } from './search-index.js';

export class SkillCatalog {
  private snapshot: readonly AgentSkill[] = [];
  private searchIndex = new SkillSearchIndex([]);

  /**
   * 创建 `SkillCatalog`，由该实例独占 Skill 公开入口 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
   */
  constructor(private readonly config: CodingAgentConfig) {}

  /**
   * 初始化 Skill 公开入口 模块 所需的目录、连接或缓存；完成前不得使用依赖这些资源的操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在依赖资源全部可用后兑现；兑现前实例仍视为未就绪。
   *
   * Throws:
   * - 当 Skill 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async initialize(): Promise<readonly AgentSkill[]> {
    return this.reload();
  }

  /**
   * 读取 Skill 公开入口 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  list(): readonly AgentSkill[] {
    return this.snapshot;
  }

  /**
   * 读取 Skill 公开入口 模块 的 `get` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `name`: `get` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
   */
  get(name: string): AgentSkill | undefined {
    return this.snapshot.find((skill) => skill.name === name);
  }

  /**
   * 在 Skill 公开入口 模块 中执行 `search` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `query`: `search` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  search(query: string): readonly AgentSkill[] {
    return this.searchIndex.search(query, 8).map((result) => result.skill);
  }

  /**
   * 执行 Skill 公开入口 模块 定义的 `reload` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Skill 公开入口 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async reload(): Promise<readonly AgentSkill[]> {
    // buildCatalog 完成全部 IO/schema 校验后才替换快照，失败时保留上一份可用结果。
    const next = await buildCatalog(this.config);
    this.snapshot = Object.freeze(next);
    this.searchIndex = new SkillSearchIndex(this.snapshot);
    return this.snapshot;
  }
}

/**
 * 读取 Skill 公开入口 模块 的 `loadCodingSkills` 视图，不转移底层状态所有权。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 *
 * Returns:
 * - Promise 在 Skill 公开入口 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 Skill 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function loadCodingSkills(
  config: CodingAgentConfig,
): Promise<AgentSkill[]> {
  return buildCatalog(config);
}

/**
 * 在 Skill 公开入口 模块 中执行 `searchCodingSkills` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 * - `query`: `searchCodingSkills` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 Skill 公开入口 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
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
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 执行 Skill 公开入口 模块 定义的 `formatSkillList` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `skills`: `formatSkillList` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `formatSkillList` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function formatSkillList(skills: readonly AgentSkill[]): string {
  if (skills.length === 0) return 'skills\t<none>';
  return skills
    .map(
      (skill) =>
        `${skill.name}\t${skill.source}\t${skill.description}\t${skill.skillPath}`,
    )
    .join('\n');
}

/**
 * 执行 Skill 公开入口 模块 定义的 `formatSkill` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `skill`: `formatSkill` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `formatSkill` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function formatSkill(skill: AgentSkill): string {
  return [
    `name\t${skill.name}`,
    `source\t${skill.source}`,
    `description\t${skill.description}`,
    `baseDir\t${skill.baseDir}`,
    `realPath\t${skill.realPath}`,
  ].join('\n');
}
