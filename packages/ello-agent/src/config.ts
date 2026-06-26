import { z } from 'zod';

/**
 * 模型支持的能力枚举。
 *
 * 与 Python 版 ModelCapability 保持同名同值, 供上下文管理、
 * 多模态输入限制和后续工具筛选逻辑复用。
 */
export const ModelCapability = {
  vision: 'vision',
  videoUnderstanding: 'video_understanding',
  documentUnderstanding: 'document_understanding',
  audioUnderstanding: 'audio_understanding',
} as const;

/** 模型能力字符串类型。 */
export type ModelCapability =
  (typeof ModelCapability)[keyof typeof ModelCapability];

/** 模型能力的 Zod 校验器。 */
export const ModelCapabilitySchema = z.enum([
  ModelCapability.vision,
  ModelCapability.videoUnderstanding,
  ModelCapability.documentUnderstanding,
  ModelCapability.audioUnderstanding,
]);

/** ModelConfig 的输入结构。 */
export const ModelConfigSchema = z.preprocess(
  (value) =>
    normalizeObjectKeys(value, {
      context_window: 'contextWindow',
      proactive_context_management_threshold:
        'proactiveContextManagementThreshold',
      compact_threshold: 'compactThreshold',
      max_images: 'maxImages',
      cold_start_trim_seconds: 'coldStartTrimSeconds',
    }),
  z
    .object({
      contextWindow: z.number().int().positive().nullable().default(null),
      proactiveContextManagementThreshold: z
        .number()
        .min(0)
        .max(1)
        .nullable()
        .default(0.65),
      compactThreshold: z.number().min(0).max(1).default(0.9),
      maxImages: z.number().int().nonnegative().default(20),
      coldStartTrimSeconds: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .default(3600),
      capabilities: z
        .array(ModelCapabilitySchema)
        .or(z.set(ModelCapabilitySchema))
        .default([])
        .transform((value) => new Set(value)),
    })
    .passthrough(),
);

/** Shell 命令审查配置的输入结构。 */
export const ShellReviewConfigSchema = z.preprocess(
  (value) =>
    normalizeObjectKeys(value, {
      allow_patterns: 'allowPatterns',
      deny_patterns: 'denyPatterns',
      require_approval: 'requireApproval',
    }),
  z.object({
    allowPatterns: z.array(z.string()).default([]),
    denyPatterns: z.array(z.string()).default([]),
    requireApproval: z.boolean().default(false),
  }),
);

/** 安全策略配置的输入结构。 */
export const SecurityConfigSchema = z.preprocess(
  (value) =>
    normalizeObjectKeys(value, {
      shell_review: 'shellReview',
      max_tool_calls_per_turn: 'maxToolCallsPerTurn',
      allowed_paths: 'allowedPaths',
      denied_paths: 'deniedPaths',
    }),
  z.object({
    shellReview: ShellReviewConfigSchema.nullable().default(null),
    maxToolCallsPerTurn: z.number().int().positive().nullable().default(null),
    allowedPaths: z.array(z.string()).default([]),
    deniedPaths: z.array(z.string()).default([]),
  }),
);

/** ToolConfig 的输入结构。 */
export const ToolConfigSchema = z.preprocess(
  (value) =>
    normalizeObjectKeys(value, {
      view_max_text_file_size: 'viewMaxTextFileSize',
      shell_output_truncate_limit: 'shellOutputTruncateLimit',
      shell_default_timeout_seconds: 'shellDefaultTimeoutSeconds',
    }),
  z
    .object({
      viewMaxTextFileSize: z
        .number()
        .int()
        .positive()
        .default(10 * 1024 * 1024),
      shellOutputTruncateLimit: z.number().int().positive().default(20_000),
      shellDefaultTimeoutSeconds: z.number().positive().default(120),
      security: SecurityConfigSchema.nullable().default(null),
    })
    .passthrough(),
);

/** Shell 命令审查配置。 */
export type ShellReviewConfig = z.infer<typeof ShellReviewConfigSchema>;

/** 安全策略配置。 */
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

/** 工具行为配置。 */
export type ToolConfigData = z.infer<typeof ToolConfigSchema>;

/** 模型行为配置。 */
export type ModelConfigData = z.infer<typeof ModelConfigSchema>;

/**
 * 模型配置, 用于上下文管理和能力判定。
 *
 * Args:
 *   input: 可选的配置覆盖项, 未传入字段会使用 Python 版默认值。
 */
export class ModelConfig {
  /** 模型上下文窗口大小; 为 null 时不启用上下文管理。 */
  readonly contextWindow: number | null;

  /** 主动上下文管理阈值; 使用率超过时触发提醒。 */
  readonly proactiveContextManagementThreshold: number | null;

  /** 自动压缩阈值; 使用率超过时触发 compact。 */
  readonly compactThreshold: number;

  /** 消息历史中允许的最大图片数量。 */
  readonly maxImages: number;

  /** KV cache 冷启动截断阈值秒数。 */
  readonly coldStartTrimSeconds: number | null;

  /** 模型支持的能力集合。 */
  readonly capabilities: Set<ModelCapability>;

  /** 保留 Zod passthrough 接收的额外字段, 对齐 Pydantic extra=allow。 */
  readonly extra: Record<string, unknown>;

  constructor(input: Partial<ModelConfigData> & Record<string, unknown> = {}) {
    const parsed = ModelConfigSchema.parse(input);
    this.contextWindow = parsed.contextWindow;
    this.proactiveContextManagementThreshold =
      parsed.proactiveContextManagementThreshold;
    this.compactThreshold = parsed.compactThreshold;
    this.maxImages = parsed.maxImages;
    this.coldStartTrimSeconds = parsed.coldStartTrimSeconds;
    this.capabilities = parsed.capabilities;

    const known = new Set([
      'contextWindow',
      'proactiveContextManagementThreshold',
      'compactThreshold',
      'maxImages',
      'coldStartTrimSeconds',
      'capabilities',
    ]);
    this.extra = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !known.has(key)),
    );
    Object.assign(this, this.extra);
  }

  /**
   * 检查模型是否具有指定能力。
   *
   * Args:
   *   capability: 要检查的能力。
   *
   * Returns:
   *   true 表示模型具有该能力。
   */
  hasCapability(capability: ModelCapability): boolean {
    return this.capabilities.has(capability);
  }

  /** Python 兼容命名: 检查模型是否具有指定能力。 */
  has_capability(capability: ModelCapability): boolean {
    return this.hasCapability(capability);
  }

  /** 模型是否支持图像理解。 */
  get hasVision(): boolean {
    return this.hasCapability(ModelCapability.vision);
  }

  /** Python 兼容命名: 模型是否支持图像理解。 */
  get has_vision(): boolean {
    return this.hasVision;
  }

  /** 模型是否支持视频理解。 */
  get hasVideoUnderstanding(): boolean {
    return this.hasCapability(ModelCapability.videoUnderstanding);
  }

  /** Python 兼容命名: 模型是否支持视频理解。 */
  get has_video_understanding(): boolean {
    return this.hasVideoUnderstanding;
  }

  /** 模型是否支持音频理解。 */
  get hasAudioUnderstanding(): boolean {
    return this.hasCapability(ModelCapability.audioUnderstanding);
  }

  /** Python 兼容命名: 模型是否支持音频理解。 */
  get has_audio_understanding(): boolean {
    return this.hasAudioUnderstanding;
  }

  /** 模型是否支持文档理解。 */
  get hasDocumentUnderstanding(): boolean {
    return this.hasCapability(ModelCapability.documentUnderstanding);
  }

  /** Python 兼容命名: 模型是否支持文档理解。 */
  get has_document_understanding(): boolean {
    return this.hasDocumentUnderstanding;
  }
}

/**
 * 工具级别配置, 控制文件读取、shell 输出和安全策略。
 *
 * Args:
 *   input: 可选的配置覆盖项, 未传入字段会使用 Python 版默认值。
 */
export class ToolConfig {
  /** 文件读取工具允许的最大文本文件大小, 默认 10MB。 */
  readonly viewMaxTextFileSize: number;

  /** Shell 输出截断阈值。 */
  readonly shellOutputTruncateLimit: number;

  /** Shell 命令默认超时秒数。 */
  readonly shellDefaultTimeoutSeconds: number;

  /** 安全策略配置; 为 null 时不启用。 */
  readonly security: SecurityConfig | null;

  /** 保留 Zod passthrough 接收的额外字段, 对齐 Pydantic extra=allow。 */
  readonly extra: Record<string, unknown>;

  constructor(input: Partial<ToolConfigData> & Record<string, unknown> = {}) {
    const parsed = ToolConfigSchema.parse(input);
    this.viewMaxTextFileSize = parsed.viewMaxTextFileSize;
    this.shellOutputTruncateLimit = parsed.shellOutputTruncateLimit;
    this.shellDefaultTimeoutSeconds = parsed.shellDefaultTimeoutSeconds;
    this.security = parsed.security;

    const known = new Set([
      'viewMaxTextFileSize',
      'shellOutputTruncateLimit',
      'shellDefaultTimeoutSeconds',
      'security',
    ]);
    this.extra = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !known.has(key)),
    );
    Object.assign(this, this.extra);
  }
}

function normalizeObjectKeys(
  value: unknown,
  mapping: Record<string, string>,
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const result: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const [from, to] of Object.entries(mapping)) {
    if (from in result && !(to in result)) {
      result[to] = result[from];
    }
  }
  return result;
}
