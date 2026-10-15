/**
 * 本文件负责 config feature 的运行时 schema 与派生类型。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import { SessionModeSchema } from '../../protocol/v1/index.js';

export const PermissionActionSchema = z.enum(['allow', 'ask', 'deny']);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

export const PermissionScopeSchema = z.enum([
  'default',
  'session',
  'project',
  'user',
]);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

/** 权限规则的持久化 schema；工具判定与配置读写共享同一解析边界。 */
export const PermissionRuleSchema = z.object({
  permission: z.string().min(1),
  pattern: z.string().min(1),
  action: PermissionActionSchema,
  scope: PermissionScopeSchema.default('session'),
  source: z.string().optional(),
  reason: z.string().optional(),
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

/** agent 运行形态与模型选择正交。 */
export const AgentModeSchema = z.enum([
  'primary',
  'subagent',
  'internal',
  'all',
]);

export const AgentModelSelectorSchema = z.enum([
  'primary_model',
  'auxiliary_model',
]);
export type AgentModelSelector = z.infer<typeof AgentModelSelectorSchema>;

const HttpHeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const HttpHeaderValueSchema = z
  .string()
  .min(1)
  .regex(/^[^\r\n]+$/u);
const HttpHeadersSchema = z.record(HttpHeaderNameSchema, HttpHeaderValueSchema);

/** Agent 回合上限；`-1` 明确表示不设置回合上限。 */
export const AgentMaxTurnsSchema = z.union([
  z.literal(-1),
  z.number().int().positive(),
]);

/** config.yaml `agent:` 映射下单个 agent 的声明。 */
export const AgentConfigSchema = z
  .object({
    mode: AgentModeSchema.default('primary'),
    model: AgentModelSelectorSchema,
    description: z.string().optional(),
    hidden: z.boolean().optional(),
    prompt: z.string().optional(),
    commands: z.array(z.string()).optional(),
    permission: z.array(PermissionRuleSchema).optional(),
    max_turns: AgentMaxTurnsSchema,
    color: z.string().optional(),
  })
  .strict();

const CommonModelFields = {
  api_model: z.string().min(1),
  base_url: z.url(),
  api_key_env: z.string().min(1),
  http_headers: HttpHeadersSchema.optional(),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  reasoning_effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .default('medium'),
};

export const AnthropicAuthSchemeSchema = z.enum(['api-key', 'bearer']);
export type AnthropicAuthScheme = z.infer<typeof AnthropicAuthSchemeSchema>;

export const ModelConfigSchema = z
  .discriminatedUnion('protocol', [
    z
      .object({
        protocol: z.literal('openai'),
        endpoint: z.enum(['responses', 'chat']),
        ...CommonModelFields,
      })
      .strict(),
    z
      .object({
        protocol: z.literal('anthropic'),
        auth_scheme: AnthropicAuthSchemeSchema,
        ...CommonModelFields,
      })
      .strict(),
    z
      .object({
        protocol: z.literal('openai-compatible'),
        endpoint: z.enum(['responses', 'chat']),
        ...CommonModelFields,
      })
      .strict(),
  ])
  .superRefine((model, context) => {
    if (model.max_output_tokens > model.context_window) {
      context.addIssue({
        code: 'custom',
        path: ['max_output_tokens'],
        message: 'must not exceed context_window',
      });
    }
    if (model.http_headers === undefined) return;

    const reservedHeader =
      model.protocol === 'anthropic' && model.auth_scheme === 'api-key'
        ? 'x-api-key'
        : 'authorization';
    const seen = new Set<string>();
    for (const headerName of Object.keys(model.http_headers)) {
      const normalizedName = headerName.toLowerCase();
      if (seen.has(normalizedName)) {
        context.addIssue({
          code: 'custom',
          path: ['http_headers', headerName],
          message: 'must not repeat a header name case-insensitively',
        });
      }
      seen.add(normalizedName);
      if (normalizedName === reservedHeader) {
        context.addIssue({
          code: 'custom',
          path: ['http_headers', headerName],
          message: `must not override provider authentication header ${reservedHeader}`,
        });
      }
    }
  });

const DEFAULT_COMMAND_SEARCH_CONFIG = {
  result_limit: 6,
  max_result_bytes: 24_000,
};

const DEFAULT_COMMAND_CONFIG: {
  readonly disabled: string[];
  readonly need_approval: string[];
  readonly search: typeof DEFAULT_COMMAND_SEARCH_CONFIG;
} = {
  disabled: [],
  need_approval: [],
  search: DEFAULT_COMMAND_SEARCH_CONFIG,
};

/** command_search 的单次结果数量与总字节限制。 */
export const CommandSearchConfigSchema = z
  .object({
    result_limit: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(DEFAULT_COMMAND_SEARCH_CONFIG.result_limit),
    max_result_bytes: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_COMMAND_SEARCH_CONFIG.max_result_bytes),
  })
  .strict();

export const CommandConfigSchema = z
  .object({
    /** 完全不注册的 Command 名。 */
    disabled: z.array(z.string()).default(DEFAULT_COMMAND_CONFIG.disabled),
    /** 非 Plan 模式下始终需要审批的 Command 名。 */
    need_approval: z
      .array(z.string())
      .default(DEFAULT_COMMAND_CONFIG.need_approval),
    search: CommandSearchConfigSchema.default(DEFAULT_COMMAND_SEARCH_CONFIG),
  })
  .strict();

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
  threshold_percent: z.number().positive().max(100).default(90),
  prune_tool_output: z.boolean().default(false),
  tool_output_max_chars: z.number().int().positive().default(2_000),
  /** 单 turn 超预算时允许切到 turn 内 assistant 边界（split turn，§1.5）。 */
  split_turns: z.boolean().default(true),
});

export const PromptModeSchema = z.enum(['rapid', 'thorough']);
export type PromptMode = z.infer<typeof PromptModeSchema>;

/** 文件型 memory 注入配置。 */
export const ContextMemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  private_dir: z.string().default('~/.ello/memory/private'),
  team_dir: z.string().default('.ello/memory/team'),
  extraction: z
    .object({
      enabled: z.boolean().default(true),
      recent_messages: z.number().int().positive().default(40),
      max_attempts: z.number().int().positive().default(2),
    })
    .default({
      enabled: true,
      recent_messages: 40,
      max_attempts: 2,
    }),
});

/** context pipeline 总配置。 */
export const ContextConfigSchema = z
  .object({
    max_input_tokens: z.number().int().positive().default(1_000_000),
    show_sources_in_tui: z.boolean().default(true),
    prompt_mode: PromptModeSchema.default('rapid'),
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
      threshold_percent: 90,
      prune_tool_output: false,
      tool_output_max_chars: 2_000,
      split_turns: true,
    }),
    memory: ContextMemoryConfigSchema.default({
      enabled: false,
      private_dir: '~/.ello/memory/private',
      team_dir: '.ello/memory/team',
      extraction: {
        enabled: true,
        recent_messages: 40,
        max_attempts: 2,
      },
    }),
  })
  .strict();

export const GoalConfigSchema = z.object({
  max_continuations: z.number().int().positive().default(20),
});

const LangfuseTracingConfigSchema = z
  .object({
    enabled: z.literal(true),
    base_url: z.url(),
    environment: z.string().min(1),
    release: z.string().min(1),
    content: z.enum(['metadata', 'full']),
  })
  .strict();

const LangfuseDisabledConfigSchema = z
  .object({
    enabled: z.literal(false),
    base_url: z.unknown().optional(),
    environment: z.unknown().optional(),
    release: z.unknown().optional(),
    content: z.unknown().optional(),
  })
  .strict();

export const LangfuseObservabilityConfigSchema = z.discriminatedUnion(
  'enabled',
  [LangfuseTracingConfigSchema, LangfuseDisabledConfigSchema],
);

export const ObservabilityConfigSchema = z
  .object({ langfuse: LangfuseObservabilityConfigSchema })
  .strict();

/** 项目信任配置，按绝对路径做 key。 */
export const ProjectTrustSchema = z.object({
  trust_level: z.enum(['trusted', 'untrusted']).default('untrusted'),
});

export const WorkspaceConfigSchema = z.object({
  mount: z.string().default('~/.ello'),
});

export const SubagentsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cwd_policy: z.enum(['workspace', 'allowed_paths']).default('allowed_paths'),
});

/**
 * 运行时最终配置 schema。
 *
 * `models` 是完整模型配置的命名目录；两个顶层引用字段决定 Agent 的模型选择。
 */
export const CodingAgentConfigSchema = z
  .object({
    /** 默认主 agent；必须解析到一个 mode=primary|all 且非 hidden 的 agent。 */
    default_agent: z.string().default('build'),
    /** 用户自定义/覆盖的 agent 声明，与内置 agent 合并。 */
    agent: z.record(z.string(), AgentConfigSchema).default({}),
    models: z.record(z.string().min(1), ModelConfigSchema),
    primary_model: z.string().min(1),
    auxiliary_model: z.string().min(1),
    projects: z.record(z.string(), ProjectTrustSchema).default({}),
    workspace: WorkspaceConfigSchema.default({ mount: '~/.ello' }),
    subagents: SubagentsConfigSchema.default({
      enabled: true,
      cwd_policy: 'allowed_paths',
    }),
    commands: CommandConfigSchema.default(DEFAULT_COMMAND_CONFIG),
    tool_output: ToolOutputConfigSchema.default({
      max_bytes: 12_000,
      max_lines: 400,
      preview_lines: 120,
    }),
    cwd: z.string().default(process.cwd()),
    allowed_paths: z.array(z.string()).default([]),
    session_dir: z.string().default(''),
    session_id: z.string().nullable().default(null),
    /** 新会话必须明确给出初始模式；缺失时启动失败，不从 agent 名称推断。 */
    initial_mode: SessionModeSchema,
    /** bypass 的独立安全闸门；仅配置 initial_mode=bypass 仍不足以启用。 */
    bypass_enabled: z.boolean().default(false),
    /** 开启后使用 title role 模型生成 Thread 标题；关闭时直接使用第一条用户消息。 */
    title_generation: z.boolean().default(false),
    permission_rules: z.array(PermissionRuleSchema).default([]),
    mcp_config_path: z.string().nullable().default(null),
    context: ContextConfigSchema.default({
      max_input_tokens: 1_000_000,
      show_sources_in_tui: true,
      prompt_mode: 'rapid',
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
        threshold_percent: 90,
        prune_tool_output: false,
        tool_output_max_chars: 2_000,
        split_turns: true,
      },
      memory: {
        enabled: false,
        private_dir: '~/.ello/memory/private',
        team_dir: '.ello/memory/team',
        extraction: {
          enabled: true,
          recent_messages: 40,
          max_attempts: 2,
        },
      },
    }),
    goal: GoalConfigSchema.default({ max_continuations: 20 }),
    observability: ObservabilityConfigSchema.optional(),
    tui: z.boolean().default(true),
    json: z.boolean().default(false),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.initial_mode === 'bypass' && !config.bypass_enabled) {
      context.addIssue({
        code: 'custom',
        path: ['bypass_enabled'],
        message: 'bypass_enabled must be true when initial_mode is bypass.',
      });
    }
    for (const field of ['primary_model', 'auxiliary_model'] as const) {
      if (config.models[config[field]] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `references unknown model: ${config[field]}`,
        });
      }
    }
  });

export type AgentConfigEntry = z.infer<typeof AgentConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type CommandConfig = z.infer<typeof CommandConfigSchema>;
export type ToolOutputConfig = z.infer<typeof ToolOutputConfigSchema>;
export type ContextCompactionConfig = z.infer<
  typeof ContextCompactionConfigSchema
>;
export type ContextMemoryConfig = z.infer<typeof ContextMemoryConfigSchema>;
export type ContextConfig = z.infer<typeof ContextConfigSchema>;
export type GoalConfig = z.infer<typeof GoalConfigSchema>;
export type LangfuseObservabilityConfig = z.infer<
  typeof LangfuseObservabilityConfigSchema
>;
export type LangfuseTracingConfig = Extract<
  LangfuseObservabilityConfig,
  { readonly enabled: true }
>;
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type SubagentsConfig = z.infer<typeof SubagentsConfigSchema>;
export type CodingAgentConfig = z.infer<typeof CodingAgentConfigSchema>;
export type CodingAgentConfigOverrides = Partial<CodingAgentConfig>;
