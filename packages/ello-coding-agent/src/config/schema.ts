import { z } from 'zod';

/** 审批模式：与 CLI `--approval`、权限策略和 system prompt 中的说明保持一致。 */
export const ApprovalModeSchema = z.enum([
  'default',
  'plan',
  'accept-edits',
  'dont-ask',
  'bypass',
]);

/** 可持久化的细粒度权限规则，来源包括 config.toml 和运行时审批写入。 */
export const PermissionRuleSchema = z.object({
  action: z.enum(['allow', 'ask', 'deny']),
  tool: z.string().optional(),
  pathGlob: z.string().optional(),
  commandPattern: z.string().optional(),
  domain: z.string().optional(),
  scope: z.enum(['session', 'project', 'user', 'default']).default('session'),
  reason: z.string().optional(),
});

/**
 * 模型 provider 只描述“连接配置”，不决定模型协议。
 *
 * 协议由 model profile 里的 `model` 前缀表达，例如 `openai-chat:*` 或
 * `openai-responses:*`。这样同一个 provider endpoint 可以承载多个协议。
 */
export const ModelProviderSchema = z.object({
  name: z.string().optional(),
  base_url: z.string().optional(),
  protocols: z.array(z.string()).default([]),
  requires_auth: z.boolean().default(true),
  env_key: z.string().optional(),
  http_headers: z.record(z.string(), z.string()).default({}),
});

/** 可切换的模型档案；TUI `/model` 切换的是 profile，而不是裸 model 字符串。 */
export const ModelProfileSchema = z.object({
  model_provider: z.string().nullable().default(null),
  model: z.string(),
  model_reasoning_effort: z
    .enum(['minimal', 'low', 'medium', 'high'])
    .nullable()
    .default(null),
  personality: z.string().nullable().default(null),
});

/** 工具注册与审批偏好配置，实际消费点在 tools/index.ts 与 permission/policy.ts。 */
export const ToolConfigSchema = z.object({
  needApproval: z.array(z.string()).default([]),
  disabled: z.array(z.string()).default([]),
});

/** 项目信任配置，按绝对路径做 key，保留与 Codex 风格相近的 TOML 表结构。 */
export const ProjectTrustSchema = z.object({
  trust_level: z.enum(['trusted', 'untrusted']).default('untrusted'),
});

/**
 * 运行时最终配置 schema。
 *
 * 注意：这里包含少量“派生字段”（如 model/baseUrl/apiKey/httpHeaders/modelCandidates），
 * 它们通常不直接写在模板顶层，而是在 loader 中由 model_profiles/model_providers
 * 解析出来，供 runtime、TUI 和 adapter 直接消费。
 */
export const CodingAgentConfigSchema = z.object({
  model_profile: z.string().nullable().default(null),
  default_model_profile: z.string().nullable().default(null),
  model_provider: z.string().nullable().default(null),
  model: z.string().default('openai-chat:deepseek-v4-flash'),
  model_reasoning_effort: z
    .enum(['minimal', 'low', 'medium', 'high'])
    .nullable()
    .default(null),
  personality: z.string().nullable().default(null),
  model_providers: z.record(z.string(), ModelProviderSchema).default({}),
  model_profiles: z.record(z.string(), ModelProfileSchema).default({}),
  projects: z.record(z.string(), ProjectTrustSchema).default({}),
  tools: ToolConfigSchema.default({ needApproval: [], disabled: [] }),
  modelCandidates: z.array(z.string()).default([]),
  baseUrl: z.string().nullable().default(null),
  apiKey: z.string().nullable().default(null),
  httpHeaders: z.record(z.string(), z.string()).default({}),
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
export type ModelProviderConfig = z.infer<typeof ModelProviderSchema>;
export type ModelProfileConfig = z.infer<typeof ModelProfileSchema>;
export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type CodingAgentConfig = z.infer<typeof CodingAgentConfigSchema>;
export type CodingAgentConfigOverrides = Partial<CodingAgentConfig>;
