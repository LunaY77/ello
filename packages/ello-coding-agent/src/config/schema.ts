import { z } from 'zod';

/** 审批模式：与 CLI `--approval`、权限策略和 system prompt 中的说明保持一致。 */
export const ApprovalModeSchema = z.enum([
  'default',
  'plan',
  'accept-edits',
  'dont-ask',
  'bypass',
]);

/** 可持久化的细粒度权限规则，来源包括 config.yaml 和运行时审批写入。 */
export const PermissionRuleSchema = z.object({
  action: z.enum(['allow', 'ask', 'deny']),
  tool: z.string().optional(),
  pathGlob: z.string().optional(),
  commandPattern: z.string().optional(),
  domain: z.string().optional(),
  scope: z.enum(['session', 'project', 'user', 'default']).default('session'),
  reason: z.string().optional(),
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
  status: z.enum(['active', 'beta', 'alpha']),
  release_date: z.string().optional(),
  context: z.number().int().positive(),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().positive(),
  cost: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative(),
    cache_write: z.number().nonnegative(),
  }),
  temperature: z.boolean(),
  reasoning: z.boolean(),
  tool_call: z.boolean(),
  input_modalities: z.array(z.enum(['text', 'audio', 'image', 'video', 'pdf'])),
  output_modalities: z.array(
    z.enum(['text', 'audio', 'image', 'video', 'pdf']),
  ),
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
    summary: z.string(),
    title: z.string(),
    review: z.string(),
  }),
  settings: z
    .object({
      primary: ModelRoleSettingsSchema.optional(),
      small: ModelRoleSettingsSchema.optional(),
      summary: ModelRoleSettingsSchema.optional(),
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
  tui: z.boolean().default(true),
  json: z.boolean().default(false),
});

export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type ProviderConnectionConfig = z.infer<typeof ProviderConnectionSchema>;
export type ModelCatalogEntryConfig = z.infer<typeof ModelCatalogEntrySchema>;
export type ModelRoleSettingsConfig = z.infer<typeof ModelRoleSettingsSchema>;
export type ProfileSuiteConfig = z.infer<typeof ProfileSuiteSchema>;
export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type ToolOutputConfig = z.infer<typeof ToolOutputConfigSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type CodingAgentConfig = z.infer<typeof CodingAgentConfigSchema>;
export type CodingAgentConfigOverrides = Partial<CodingAgentConfig>;
