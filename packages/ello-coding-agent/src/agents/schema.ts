import { z } from 'zod';

import {
  AgentModeSchema,
  AgentRoleSchema,
  ApprovalModeSchema,
  PermissionRuleSchema,
  type AgentConfigEntry,
  type ApprovalMode,
  type PermissionRule,
} from '../config/schema.js';
import type { ModelRole } from '../provider/types.js';

/**
/** agent 运行形态。 */
export type CodingAgentMode = z.infer<typeof AgentModeSchema>;

/** agent 定义的来源，按 registry 合并顺序覆盖。 */
export type CodingAgentSource =
  | 'builtin'
  | 'bundled'
  | 'config'
  | 'global'
  | 'project';

/**
 * 统一的 agent 定义。
 *
 * primary / subagent / internal agent 用同一套结构建模：绑定一个 profile
 * suite 的 `role`（而非独立 profile），声明 prompt、工具名白名单、approval 预设
 * 与静态权限。运行时由 agent-runner 把它装配成一个 `@ello/agent` 的 Agent。
 */
export interface CodingAgentDefinition {
  readonly name: string;
  readonly mode: CodingAgentMode;
  /** 委派/选择时给模型和用户看的描述。 */
  readonly description: string;
  /** 兜底隐藏（internal 恒等于隐藏）。 */
  readonly hidden?: boolean;
  /** 追加到系统提示的指令正文。 */
  readonly prompt?: string;
  /** 绑定 profile suite 中的哪个 role；默认 primary（= 继承主模型）。 */
  readonly role: ModelRole;
  /** 极少数情况显式锁定模型 ref，优先级高于 role 解析。 */
  readonly modelRef?: string;
  /** 工具名白名单；缺省时由 mode 决定默认（见 agent-runner）。 */
  readonly tools?: readonly string[];
  /** 该 agent 的初始 approval 预设。 */
  readonly approvalMode?: ApprovalMode;
  /** 静态 permission 规则（与派生规则、运行期规则合并）。 */
  readonly permission?: readonly PermissionRule[];
  readonly maxTurns?: number;
  readonly color?: string;
  readonly source: CodingAgentSource;
}

/**
 * Markdown agent 的 frontmatter schema。字段类型错误直接抛错。
 */
export const MarkdownAgentFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string(),
    mode: AgentModeSchema.optional(),
    role: AgentRoleSchema.optional(),
    tools: z.union([z.array(z.string()), z.string()]).optional(),
    'inherit-tools': z.boolean().optional(),
    inheritTools: z.boolean().optional(),
    'approval-mode': ApprovalModeSchema.optional(),
    approvalMode: ApprovalModeSchema.optional(),
    permission: z.array(PermissionRuleSchema).optional(),
    'max-turns': z.number().int().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
    color: z.string().optional(),
  })
  .strict();

export type MarkdownAgentFrontmatter = z.infer<
  typeof MarkdownAgentFrontmatterSchema
>;

/** 把 `tools` frontmatter 字段规整为字符串名数组（逗号串或数组皆可）。 */
function normalizeToolNames(
  value: readonly string[] | string | undefined,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const list: string[] = Array.isArray(value)
    ? [...value]
    : (value as string)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
  return list.length > 0 ? list : undefined;
}

/**
 * 由 config.yaml `agent:` 映射的单个条目构造定义。
 *
 * config 用 snake_case，这里映射成 camelCase 的 {@link CodingAgentDefinition}，
 * 并补齐 name 与 source。
 */
export function agentDefinitionFromConfigEntry(
  name: string,
  entry: AgentConfigEntry,
  source: CodingAgentSource,
): CodingAgentDefinition {
  return {
    name,
    mode: entry.mode,
    role: entry.role,
    description: entry.description ?? name,
    source,
    ...(entry.hidden !== undefined ? { hidden: entry.hidden } : {}),
    ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
    ...(entry.model !== undefined ? { modelRef: entry.model } : {}),
    ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
    ...(entry.approval_mode !== undefined
      ? { approvalMode: entry.approval_mode }
      : {}),
    ...(entry.permission !== undefined ? { permission: entry.permission } : {}),
    ...(entry.max_turns !== undefined ? { maxTurns: entry.max_turns } : {}),
    ...(entry.color !== undefined ? { color: entry.color } : {}),
  };
}

/**
 * 由 Markdown frontmatter + 正文构造定义。
 *
 * Markdown agent 默认是可委派的 `subagent`（对齐 claude-code 的子代理文件语义）；
 * 正文即 prompt。frontmatter 已由 {@link MarkdownAgentFrontmatterSchema} 校验。
 */
export function agentDefinitionFromMarkdown(input: {
  readonly frontmatter: MarkdownAgentFrontmatter;
  readonly body: string;
  readonly defaultName: string;
  readonly source: CodingAgentSource;
}): CodingAgentDefinition {
  const { frontmatter, body, defaultName, source } = input;
  if (
    frontmatter.inheritTools === true &&
    frontmatter['inherit-tools'] === false
  ) {
    throw new Error('Markdown agent has conflicting inheritTools settings.');
  }
  if (
    frontmatter.inheritTools === false &&
    frontmatter['inherit-tools'] === true
  ) {
    throw new Error('Markdown agent has conflicting inheritTools settings.');
  }
  const tools = normalizeToolNames(frontmatter.tools);
  const approvalMode = frontmatter['approval-mode'] ?? frontmatter.approvalMode;
  const maxTurns = frontmatter['max-turns'] ?? frontmatter.maxTurns;
  const prompt = body.trim();
  const permission = frontmatter.permission;
  const inheritTools = frontmatter['inherit-tools'] ?? frontmatter.inheritTools;
  return {
    name: frontmatter.name ?? defaultName,
    mode: frontmatter.mode ?? 'subagent',
    role: frontmatter.role ?? 'primary',
    description: frontmatter.description,
    source,
    ...(prompt !== '' ? { prompt } : {}),
    ...(inheritTools === true || tools === undefined ? {} : { tools }),
    ...(approvalMode !== undefined ? { approvalMode } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(typeof frontmatter['color'] === 'string'
      ? { color: frontmatter['color'] }
      : {}),
  };
}
