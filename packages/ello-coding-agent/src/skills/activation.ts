import type { AgentSkill } from '@ello/agent';

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

  constructor(private readonly catalog: SkillCatalog) {}

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

  release(runId: string): void {
    this.active.delete(runId);
  }
}

/** 把不可变 Skill 快照序列化成唯一的模型 Tool Result 协议。 */
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
