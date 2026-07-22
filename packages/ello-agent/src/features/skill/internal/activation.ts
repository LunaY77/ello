/**
 * 本文件负责 skill feature 的“activation”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { AgentSkill } from '../../agent/engine/index.js';

import type { SkillCatalog } from './index.js';

export const ACTIVATE_SKILL_TOOL_NAME = 'activate_skill';

export interface SkillActivationRequest {
  readonly name: string;
  readonly arguments?: string | undefined;
  readonly runId: string;
}

export interface ActivatedSkill {
  readonly skill: AgentSkill;
  readonly output: string;
}

export interface SkillActivatedData {
  readonly toolCallId: string;
  readonly name: string;
  readonly source: AgentSkill['source'];
  readonly trigger: 'model';
  readonly contentHash: string;
}

/**
 * Skill 激活的唯一领域入口。
 *
 * 工具调用只读取 Catalog 当前快照；同一 run 内按 name + contentHash 去重，避免模型
 * 重复加载相同正文。服务不构造消息、不发送事件，也不持有 session 级激活状态。
 */
export class SkillActivationService {
  private readonly active = new Map<string, Set<string>>();

  /**
   * 创建 `SkillActivationService`，由该实例独占 Skill `activation` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `catalog`: `constructor SkillActivationService` 所需的业务值；函数按声明读取，不补造缺失内容。
   */
  constructor(private readonly catalog: SkillCatalog) {}

  /**
   * 执行 Skill `activation` 模块 定义的 `activate` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `request`: 进入 Skill `activation` 模块 的稳定请求；校验后只读传递，不由函数修改。
   *
   * Returns:
   * - 返回 `activate` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  activate(request: SkillActivationRequest): ActivatedSkill {
    const name = request.name.trim();
    if (name === '') throw new Error('Skill name must not be empty.');
    const skill = this.catalog.get(name);
    if (skill === undefined) {
      const suggestions = this.catalog
        .search(name)
        .slice(0, 3)
        .map((item) => item.name);
      throw new Error(
        `Unknown skill: ${name}${suggestions.length > 0 ? `. Similar: ${suggestions.join(', ')}` : ''}`,
      );
    }
    const key = `${skill.name}:${skill.contentHash}`;
    const runSkills = this.active.get(request.runId) ?? new Set<string>();
    if (runSkills.has(key)) {
      throw new Error(`Skill already activated in this run: ${skill.name}`);
    }
    const output = serializeActivatedSkill(skill);
    if (output.trim() === '')
      throw new Error(`Skill ${skill.name} produced an empty result.`);
    runSkills.add(key);
    this.active.set(request.runId, runSkills);
    return { skill, output };
  }

  /**
   * 执行 Skill `activation` 模块 定义的 `release` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `runId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Skill `activation` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  release(runId: string): void {
    this.active.delete(runId);
  }
}

/**
 * 把不可变 Skill 快照序列化成唯一的模型 Tool Result 协议。
 *
 * Args:
 * - `skill`: `serializeActivatedSkill` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `serializeActivatedSkill` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function serializeActivatedSkill(skill: AgentSkill): string {
  const name = escapeXml(skill.name);
  const source = escapeXml(skill.source);
  const path = escapeXml(skill.skillPath);
  const body = skill.instructions.replaceAll(']]>', ']]]]><![CDATA[>');
  return `<activated_skill name="${name}" source="${source}" path="${path}"><![CDATA[${body}]]></activated_skill>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}
