import { z } from 'zod';

import { PermissionRuleSchema } from '../permission/types.js';

const ZeroCostSchema = z.object({
  input: z.number().nonnegative().default(0),
  output: z.number().nonnegative().default(0),
  cache_read: z.number().nonnegative().default(0),
  cache_write: z.number().nonnegative().default(0),
});

/** 审批模式：与 CLI `--approval`、权限策略和 system prompt 中的说明保持一致。 */
export const ApprovalModeSchema = z.enum([
  'default',
  'plan',
  'accept-edits',
  'dont-ask',
  'bypass',
]);

export { PermissionRuleSchema };

/** agent 运行形态；与 provider profile suite 的 role 正交。 */
export const AgentModeSchema = z.enum([
  'primary',
  'subagent',
  'internal',
  'all',
]);

/** agent 绑定的 profile role 名；与 provider/types.ts 的 ModelRole 保持一致。 */
export const AgentRoleSchema = z.enum([
  'primary',
  'small',
  'compact',
  'title',
  'review',
]);

/** config.yaml `agent:` 映射下单个 agent 的声明。 */
export const AgentConfigSchema = z.object({
  mode: AgentModeSchema.default('primary'),
  role: AgentRoleSchema.default('primary'),
  description: z.string().optional(),
  hidden: z.boolean().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  approval_mode: ApprovalModeSchema.optional(),
  permission: z.array(PermissionRuleSchema).optional(),
  max_turns: z.number().int().positive().optional(),
  color: z.string().optional(),
});

/** provider 只描述模型服务连接方式，不承载模型人格或 agent 行为。 */
export const ProviderConnectionSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  kind: z.enum(['openai', 'anthropic', 'openai-compatible']),
  api_key_env: z.string().optional(),
  api_key: z.string().optional(),
  api_key_file: z.string().optional(),
  base_url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

/** 单个模型的 catalog 元数据和真实 API 映射。 */
export const ModelCatalogEntrySchema = z.object({
  id: z.string().optional(),
  provider: z.string(),
  name: z.string().optional(),
  api_id: z.string(),
  endpoint: z.enum(['languageModel', 'chat', 'responses', 'custom']).optional(),
  status: z.enum(['active', 'beta', 'alpha']).default('active'),
  release_date: z.string().optional(),
  context: z.number().int().positive().default(128_000),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().positive().default(16_000),
  cost: z
    .union([ZeroCostSchema, z.literal('zeroCost')])
    .default('zeroCost')
    .transform((value) =>
      value === 'zeroCost'
        ? { input: 0, output: 0, cache_read: 0, cache_write: 0 }
        : value,
    ),
  temperature: z.boolean().default(true),
  reasoning: z.boolean().default(false),
  tool_call: z.boolean().default(true),
  input_modalities: z
    .array(z.enum(['text', 'audio', 'image', 'video', 'pdf']))
    .default(['text']),
  output_modalities: z
    .array(z.enum(['text', 'audio', 'image', 'video', 'pdf']))
    .default(['text']),
  interleaved_reasoning_field: z
    .enum(['reasoning', 'reasoning_content', 'reasoning_details'])
    .optional(),
  headers: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  variants: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

/** role 级调用参数，表达同一 profile suite 中不同用途的模型调用偏好。 */
export const ModelRoleSettingsSchema = z.object({
  reasoning_effort: z
    .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    .optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  provider_options: z.record(z.string(), z.unknown()).optional(),
});

/** 一个 profile 是一组 role 到模型的明确绑定，运行时不会补齐缺失 role。 */
export const ProfileSuiteSchema = z.object({
  label: z.string().optional(),
  description: z.string().optional(),
  models: z.object({
    primary: z.string(),
    small: z.string(),
    compact: z.string(),
    title: z.string(),
    review: z.string(),
  }),
  settings: z
    .object({
      primary: ModelRoleSettingsSchema.optional(),
      small: ModelRoleSettingsSchema.optional(),
      compact: ModelRoleSettingsSchema.optional(),
      title: ModelRoleSettingsSchema.optional(),
      review: ModelRoleSettingsSchema.optional(),
    })
    .default({}),
});

/** 工具注册与审批偏好配置，实际消费点在 tools/index.ts 与 permission/policy.ts。 */
export const ToolConfigSchema = z.object({
  needApproval: z.array(z.string()).default([]),
  disabled: z.array(z.string()).default([]),
});

/** 工具长输出策略：模型拿 preview，完整内容写入 session artifact。 */
export const ToolOutputConfigSchema = z.object({
  max_bytes: z.number().int().positive().default(12_000),
  max_lines: z.number().int().positive().default(400),
  preview_lines: z.number().int().positive().default(120),
});

/** context pipeline 的指令来源配置。 */
export const ContextInstructionsConfigSchema = z.object({
  global: z.array(z.string()).default(['~/.ello/ELLO.md']),
  project: z
    .array(z.string())
    .default(['AGENTS.md', '.ello/ELLO.md', '.ello/instructions.md']),
  extra: z.array(z.string()).default([]),
  nearby: z.boolean().default(true),
});

/** context pipeline 的压缩策略配置。 */
export const ContextCompactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  tail_turns: z.number().int().positive().default(2),
  preserve_recent_tokens: z.number().int().positive().default(20_000),
  reserved_tokens: z.number().int().positive().default(16_384),
  prune_tool_output: z.boolean().default(false),
  tool_output_max_chars: z.number().int().positive().default(2_000),
  /** 单 turn 超预算时允许切到 turn 内 assistant 边界（split turn，§1.5）。 */
  split_turns: z.boolean().default(true),
});

/**
 * 大 tool 输出预算替换配置（§2）。模型输入前把超限 tool_result 写入 artifact，
 * 上下文里替换为 preview + stub。默认关闭，避免改变现有 tool 输出测试语义。
 */
export const ContextToolResultBudgetConfigSchema = z.object({
  enabled: z.boolean().default(false),
  max_chars: z.number().int().positive().default(20_000),
});

/** 文件型 memory 注入配置。 */
export const ContextMemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

/** context pipeline 总配置。 */
export const ContextConfigSchema = z.object({
  max_input_tokens: z.number().int().positive().default(160_000),
  reserved_output_tokens: z.number().int().positive().default(8_000),
  show_sources_in_tui: z.boolean().default(true),
  system_prompt_profile: z.string().default('coding'),
  instructions: ContextInstructionsConfigSchema.default({
    global: ['~/.ello/ELLO.md'],
    project: ['AGENTS.md', '.ello/ELLO.md', '.ello/instructions.md'],
    extra: [],
    nearby: true,
  }),
  compaction: ContextCompactionConfigSchema.default({
    auto: true,
    tail_turns: 2,
    preserve_recent_tokens: 20_000,
    reserved_tokens: 16_384,
    prune_tool_output: false,
    tool_output_max_chars: 2_000,
    split_turns: true,
  }),
  tool_result_budget: ContextToolResultBudgetConfigSchema.default({
    enabled: false,
    max_chars: 20_000,
  }),
  memory: ContextMemoryConfigSchema.default({
    enabled: false,
  }),
});

/** 项目信任配置，按绝对路径做 key。 */
export const ProjectTrustSchema = z.object({
  trust_level: z.enum(['trusted', 'untrusted']).default('untrusted'),
});

/**
 * 运行时最终配置 schema。
 *
 * 模型配置采用三层结构：
 * - provider：连接和认证；
 * - model：catalog 元数据和真实 API 映射；
 * - profile：用户/agent 的使用意图。
 */
export const CodingAgentConfigSchema = z.object({
  active_profile: z.string().default('main'),
  /** 默认主 agent；必须解析到一个 mode=primary|all 且非 hidden 的 agent。 */
  default_agent: z.string().default('build'),
  /** 用户自定义/覆盖的 agent 声明，与内置 agent 合并。 */
  agent: z.record(z.string(), AgentConfigSchema).default({}),
  provider: z.record(z.string(), ProviderConnectionSchema).default({}),
  models: z
    .record(z.string(), z.record(z.string(), ModelCatalogEntrySchema))
    .default({}),
  profile: z.record(z.string(), ProfileSuiteSchema).default({}),
  projects: z.record(z.string(), ProjectTrustSchema).default({}),
  tools: ToolConfigSchema.default({ needApproval: [], disabled: [] }),
  tool_output: ToolOutputConfigSchema.default({
    max_bytes: 12_000,
    max_lines: 400,
    preview_lines: 120,
  }),
  cwd: z.string().default(process.cwd()),
  allowedPaths: z.array(z.string()).default([]),
  sessionDir: z.string().default(''),
  sessionId: z.string().nullable().default(null),
  approvalMode: ApprovalModeSchema.default('default'),
  permissionRules: z.array(PermissionRuleSchema).default([]),
  mcpConfigPath: z.string().nullable().default(null),
  systemPromptProfile: z.string().default('coding'),
  context: ContextConfigSchema.default({
    max_input_tokens: 160_000,
    reserved_output_tokens: 8_000,
    show_sources_in_tui: true,
    system_prompt_profile: 'coding',
    instructions: {
      global: ['~/.ello/ELLO.md'],
      project: ['AGENTS.md', '.ello/ELLO.md', '.ello/instructions.md'],
      extra: [],
      nearby: true,
    },
    compaction: {
      auto: true,
      tail_turns: 2,
      preserve_recent_tokens: 20_000,
      reserved_tokens: 16_384,
      prune_tool_output: false,
      tool_output_max_chars: 2_000,
      split_turns: true,
    },
    tool_result_budget: {
      enabled: false,
      max_chars: 20_000,
    },
    memory: { enabled: false },
  }),
  tui: z.boolean().default(true),
  json: z.boolean().default(false),
});

export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type AgentConfigEntry = z.infer<typeof AgentConfigSchema>;
export type ProviderConnectionConfig = z.infer<typeof ProviderConnectionSchema>;
export type ModelCatalogEntryConfig = z.infer<typeof ModelCatalogEntrySchema>;
export type ModelRoleSettingsConfig = z.infer<typeof ModelRoleSettingsSchema>;
export type ProfileSuiteConfig = z.infer<typeof ProfileSuiteSchema>;
export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type ToolOutputConfig = z.infer<typeof ToolOutputConfigSchema>;
export type ContextCompactionConfig = z.infer<
  typeof ContextCompactionConfigSchema
>;
export type ContextToolResultBudgetConfig = z.infer<
  typeof ContextToolResultBudgetConfigSchema
>;
export type ContextMemoryConfig = z.infer<typeof ContextMemoryConfigSchema>;
export type ContextConfig = z.infer<typeof ContextConfigSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type CodingAgentConfig = z.infer<typeof CodingAgentConfigSchema>;
export type CodingAgentConfigOverrides = Partial<CodingAgentConfig>;
