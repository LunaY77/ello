/**
 * 技能（skill）相关支撑模块。
 *
 * 技能是一段命名的指令文本（可附带专属工具），用于按需为模型注入领域能力。
 * 本模块提供三件事：把激活中的技能拼成系统提示片段、生成 `skill_*`
 * 工具及技能自带工具集合，以及从磁盘目录加载技能定义。
 */

import { createHash } from 'node:crypto';
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
  /** 与 skill tools 共享的激活集合。 */
  readonly active?: Set<string>;
  /** 激活模式：`always-on` 全部常驻注入，`activated`（默认）仅注入已激活者。 */
  readonly activation?: 'always-on' | 'activated';
}

/** loader 的来源标记。 */
export type SkillSource = NonNullable<AgentSkill['source']>;

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

/**
 * 从一个目录加载技能：每个子目录即一个技能，其 `SKILL.md` 为指令正文。
 *
 * 技能名取自子目录名，描述取自 Markdown 的首个一级标题（缺省回退为目录名），
 * 并在元数据里记录技能所在目录。非目录项一律跳过。
 */
export async function loadSkillsFromDir(
  dir: string,
  source: SkillSource = 'global',
): Promise<AgentSkill[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: AgentSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(dir, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const raw = await readFile(skillPath, 'utf8');
    const { frontmatter, body } = parseSkillMarkdown(raw);
    const name = readString(frontmatter, 'name') ?? entry.name;
    const description =
      readString(frontmatter, 'description') ??
      body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (description === undefined || description === '') {
      throw new Error(`Skill ${name} is missing description.`);
    }
    skills.push({
      name,
      displayName:
        readString(frontmatter, 'displayName') ??
        readString(frontmatter, 'display-name'),
      description,
      whenToUse:
        readString(frontmatter, 'whenToUse') ??
        readString(frontmatter, 'when_to_use'),
      argumentHint:
        readString(frontmatter, 'argumentHint') ??
        readString(frontmatter, 'argument-hint'),
      allowedTools:
        readStringArray(frontmatter, 'allowedTools') ??
        readStringArray(frontmatter, 'allowed-tools') ??
        [],
      context: readContext(frontmatter),
      model: readString(frontmatter, 'model'),
      effort: readEffort(frontmatter),
      userInvocable:
        readBoolean(frontmatter, 'userInvocable') ??
        readBoolean(frontmatter, 'user-invocable') ??
        true,
      disableModelInvocation:
        readBoolean(frontmatter, 'disableModelInvocation') ??
        readBoolean(frontmatter, 'disable-model-invocation') ??
        false,
      source,
      baseDir: skillDir,
      contentHash: createHash('sha1').update(raw).digest('hex'),
      instructions: body.trim(),
      metadata: { dir: skillDir, frontmatter },
    });
  }
  return skills;
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
    const lines = ['# Available skills'];
    for (const skill of options.skills) {
      const line = `- ${skill.name}: ${skill.description}${skill.whenToUse ? ` (${skill.whenToUse})` : ''}`;
      if ([...lines, line].join('\n').length > budget) {
        lines.push(`- ${skill.name}`);
      } else {
        lines.push(line);
      }
    }
    return lines.join('\n');
  };
}

function parseSkillMarkdown(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }
  return {
    frontmatter: parseSimpleYaml(raw.slice(4, end)),
    body: raw.slice(end + 4).replace(/^\r?\n/u, ''),
  };
}

/** 只解析 skill frontmatter 需要的 YAML 子集。 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (match === null) {
      continue;
    }
    const key = match[1]!;
    const rawValue = match[2]!;
    if (rawValue === '') {
      const values: string[] = [];
      while (lines[index + 1]?.match(/^\s*-\s+/u)) {
        index += 1;
        values.push(lines[index]!.replace(/^\s*-\s+/u, '').trim());
      }
      result[key] = values;
    } else {
      result[key] = parseScalar(rawValue);
    }
  }
  return result;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^["']|["']$/gu, '');
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const item = value[key];
  return typeof item === 'string' && item.length > 0 ? item : undefined;
}

function readStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const item = value[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const item = value[key];
  return typeof item === 'boolean' ? item : undefined;
}

function readContext(value: Record<string, unknown>): 'inline' | 'fork' {
  return readString(value, 'context') === 'fork' ? 'fork' : 'inline';
}

function readEffort(
  value: Record<string, unknown>,
): AgentSkill['effort'] | undefined {
  const item = value.effort;
  if (typeof item === 'number') return item;
  if (
    item === 'low' ||
    item === 'medium' ||
    item === 'high' ||
    item === 'xhigh'
  ) {
    return item;
  }
  return undefined;
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
