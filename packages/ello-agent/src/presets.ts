/** ModelSettings 通用字典类型。 */
export type ModelSettings = Record<string, unknown>;

/** 1024 tokens 常量。 */
export const K_TOKENS = 1024;

/** Anthropic 1M context beta header。 */
export const ANTHROPIC_1M_BETA = 'context-1m-2025-08-07';

/** Anthropic context management beta header。 */
export const ANTHROPIC_CONTEXT_MANAGEMENT_BETA =
  'context-management-2025-06-27';

/**
 * 构建 Anthropic beta headers。
 *
 * Args:
 *   use1mContext: 是否启用 1M context。
 *   useContextManagement: 是否启用 context management。
 *
 * Returns:
 *   extra_headers 字典, 无 beta 时返回空对象。
 */
export function buildAnthropicBetas(
  options: {
    use1mContext?: boolean;
    useContextManagement?: boolean;
  } = {},
): Record<string, string> {
  const betas: string[] = [];
  if (options.use1mContext) {
    betas.push(ANTHROPIC_1M_BETA);
  }
  if (options.useContextManagement) {
    betas.push(ANTHROPIC_CONTEXT_MANAGEMENT_BETA);
  }
  return betas.length === 0 ? {} : { 'anthropic-beta': betas.join(',') };
}

/**
 * 构建 Anthropic context_management 配置。
 */
export function buildContextManagement(
  options: {
    clearToolUses?: boolean;
    toolUseTriggerTokens?: number;
    toolUseKeep?: number;
    toolUseClearAtLeast?: number | null;
    clearThinking?: boolean;
    thinkingKeepTurns?: number | 'all';
  } = {},
): ModelSettings {
  const clearToolUses = options.clearToolUses ?? false;
  const toolUseTriggerTokens = options.toolUseTriggerTokens ?? 100_000;
  const toolUseKeep = options.toolUseKeep ?? 3;
  const toolUseClearAtLeast = options.toolUseClearAtLeast ?? 20_000;
  const clearThinking = options.clearThinking ?? true;
  const thinkingKeepTurns = options.thinkingKeepTurns ?? 'all';
  const edits: ModelSettings[] = [];

  if (clearThinking) {
    const thinkingEdit: ModelSettings = { type: 'clear_thinking_20251015' };
    thinkingEdit.keep =
      thinkingKeepTurns === 'all'
        ? 'all'
        : { type: 'thinking_turns', value: thinkingKeepTurns };
    edits.push(thinkingEdit);
  }

  if (clearToolUses) {
    const toolEdit: ModelSettings = {
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: toolUseTriggerTokens },
      keep: { type: 'tool_uses', value: toolUseKeep },
    };
    if (toolUseClearAtLeast !== null) {
      toolEdit.clear_at_least = {
        type: 'input_tokens',
        value: toolUseClearAtLeast,
      };
    }
    edits.push(toolEdit);
  }

  return { edits };
}

/**
 * 将 context management 叠加到已有 settings 上。
 */
export function withContextManagement(
  settings: ModelSettings,
  contextManagement?: ModelSettings | null,
  options: Parameters<typeof buildContextManagement>[0] = {},
): ModelSettings {
  const next = structuredClone(settings);
  const cm = contextManagement ?? buildContextManagement(options);
  const extraHeaders = isRecord(next.extra_headers) ? next.extra_headers : {};
  const existingBeta =
    typeof extraHeaders['anthropic-beta'] === 'string'
      ? extraHeaders['anthropic-beta']
      : '';
  const betas = existingBeta
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!betas.includes(ANTHROPIC_CONTEXT_MANAGEMENT_BETA)) {
    betas.push(ANTHROPIC_CONTEXT_MANAGEMENT_BETA);
  }
  next.extra_headers = { ...extraHeaders, 'anthropic-beta': betas.join(',') };

  const extraBody = isRecord(next.extra_body) ? next.extra_body : {};
  next.extra_body = { ...extraBody, context_management: cm };
  return next;
}

function anthropicAdaptiveSettings(
  options: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    maxTokens?: number;
    use1mContext?: boolean;
    useContextManagement?: boolean;
    contextManagement?: ModelSettings | null;
  } = {},
): ModelSettings {
  const settings: ModelSettings = {
    max_tokens: options.maxTokens ?? 32 * K_TOKENS,
    anthropic_thinking: { type: 'adaptive', display: 'summarized' },
    anthropic_effort: options.effort ?? 'high',
    anthropic_cache_instructions: true,
    anthropic_cache_response: true,
    anthropic_cache_messages: true,
  };
  const extraHeaders = buildAnthropicBetas({
    ...(options.use1mContext !== undefined
      ? { use1mContext: options.use1mContext }
      : {}),
    ...(options.useContextManagement !== undefined
      ? { useContextManagement: options.useContextManagement }
      : {}),
  });
  if (Object.keys(extraHeaders).length > 0) {
    settings.extra_headers = extraHeaders;
  }
  if (options.useContextManagement) {
    settings.extra_body = {
      context_management: options.contextManagement ?? buildContextManagement(),
    };
  }
  return settings;
}

function anthropicOffSettings(
  options: {
    use1mContext?: boolean;
    useContextManagement?: boolean;
  } = {},
): ModelSettings {
  const settings: ModelSettings = {
    anthropic_thinking: { type: 'disabled' },
    anthropic_cache_instructions: true,
    anthropic_cache_response: true,
    anthropic_cache_messages: true,
  };
  const extraHeaders = buildAnthropicBetas({
    ...(options.use1mContext !== undefined
      ? { use1mContext: options.use1mContext }
      : {}),
    ...(options.useContextManagement !== undefined
      ? { useContextManagement: options.useContextManagement }
      : {}),
  });
  if (Object.keys(extraHeaders).length > 0) {
    settings.extra_headers = extraHeaders;
  }
  if (options.useContextManagement) {
    settings.extra_body = {
      context_management: buildContextManagement({ clearThinking: false }),
    };
  }
  return settings;
}

function openaiChatSettings(
  options: {
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | null;
    maxTokens?: number | null;
  } = {},
): ModelSettings {
  const settings: ModelSettings = {};
  if (
    options.reasoningEffort !== undefined &&
    options.reasoningEffort !== null
  ) {
    settings.openai_reasoning_effort = options.reasoningEffort;
  }
  if (options.maxTokens !== undefined && options.maxTokens !== null) {
    settings.max_tokens = options.maxTokens;
  }
  return settings;
}

function openaiResponsesSettings(options: {
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  reasoningSummary?: 'detailed' | 'concise' | 'auto';
  maxTokens?: number | null;
}): ModelSettings {
  const settings: ModelSettings = {
    openai_store: false,
    openai_reasoning_effort: options.reasoningEffort,
    openai_reasoning_summary: options.reasoningSummary ?? 'auto',
  };
  if (options.maxTokens !== undefined && options.maxTokens !== null) {
    settings.max_output_tokens = options.maxTokens;
  }
  return settings;
}

function deepseekSettings(
  options: {
    thinkingEnabled?: boolean;
    reasoningEffort?: 'high' | 'max';
    maxTokens?: number | null;
  } = {},
): ModelSettings {
  const thinkingEnabled = options.thinkingEnabled ?? true;
  const settings: ModelSettings = {
    extra_body: {
      thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
    },
  };
  if (thinkingEnabled) {
    settings.openai_reasoning_effort = options.reasoningEffort ?? 'high';
  }
  if (options.maxTokens !== undefined && options.maxTokens !== null) {
    settings.max_tokens = options.maxTokens;
  }
  return settings;
}

function geminiSettings(
  thinkingBudget: number,
  maxTokens?: number | null,
  includeThoughts = true,
): ModelSettings {
  const settings: ModelSettings = {
    google_thinking_config: {
      thinking_budget: thinkingBudget,
      include_thoughts: includeThoughts,
    },
  };
  if (maxTokens !== undefined && maxTokens !== null) {
    settings.max_tokens = maxTokens;
  }
  return settings;
}

/** 可用的 ModelSettings 预设名。 */
export const ModelSettingsPreset = {
  ANTHROPIC_DEFAULT: 'anthropic_default',
  ANTHROPIC_XHIGH: 'anthropic_xhigh',
  ANTHROPIC_HIGH: 'anthropic_high',
  ANTHROPIC_MEDIUM: 'anthropic_medium',
  ANTHROPIC_LOW: 'anthropic_low',
  ANTHROPIC_OFF: 'anthropic_off',
  ANTHROPIC_1M_DEFAULT: 'anthropic_1m_default',
  ANTHROPIC_1M_HIGH: 'anthropic_1m_high',
  ANTHROPIC_1M_MEDIUM: 'anthropic_1m_medium',
  ANTHROPIC_1M_LOW: 'anthropic_1m_low',
  ANTHROPIC_CM_DEFAULT: 'anthropic_cm_default',
  ANTHROPIC_CM_HIGH: 'anthropic_cm_high',
  ANTHROPIC_CM_MEDIUM: 'anthropic_cm_medium',
  ANTHROPIC_CM_LOW: 'anthropic_cm_low',
  OPENAI_DEFAULT: 'openai_default',
  OPENAI_XHIGH: 'openai_xhigh',
  OPENAI_HIGH: 'openai_high',
  OPENAI_MEDIUM: 'openai_medium',
  OPENAI_LOW: 'openai_low',
  OPENAI_RESPONSES_DEFAULT: 'openai_responses_default',
  OPENAI_RESPONSES_XHIGH: 'openai_responses_xhigh',
  OPENAI_RESPONSES_HIGH: 'openai_responses_high',
  OPENAI_RESPONSES_MEDIUM: 'openai_responses_medium',
  OPENAI_RESPONSES_LOW: 'openai_responses_low',
  DEEPSEEK_DEFAULT: 'deepseek_default',
  DEEPSEEK_HIGH: 'deepseek_high',
  DEEPSEEK_MAX: 'deepseek_max',
  DEEPSEEK_OFF: 'deepseek_off',
  GEMINI_DEFAULT: 'gemini_default',
  GEMINI_HIGH: 'gemini_high',
  GEMINI_MEDIUM: 'gemini_medium',
  GEMINI_LOW: 'gemini_low',
} as const;

/** ModelSettings 预设名类型。 */
export type ModelSettingsPreset =
  (typeof ModelSettingsPreset)[keyof typeof ModelSettingsPreset];

const PRESET_REGISTRY: Record<string, ModelSettings> = {
  anthropic_default: anthropicAdaptiveSettings({
    effort: 'high',
    maxTokens: 32 * K_TOKENS,
  }),
  anthropic_xhigh: anthropicAdaptiveSettings({
    effort: 'xhigh',
    maxTokens: 64 * K_TOKENS,
  }),
  anthropic_high: anthropicAdaptiveSettings({
    effort: 'high',
    maxTokens: 32 * K_TOKENS,
  }),
  anthropic_medium: anthropicAdaptiveSettings({
    effort: 'medium',
    maxTokens: 21 * K_TOKENS,
  }),
  anthropic_low: anthropicAdaptiveSettings({
    effort: 'low',
    maxTokens: 16 * K_TOKENS,
  }),
  anthropic_off: anthropicOffSettings(),
  anthropic_1m_default: anthropicAdaptiveSettings({
    effort: 'high',
    maxTokens: 32 * K_TOKENS,
    use1mContext: true,
  }),
  anthropic_1m_high: anthropicAdaptiveSettings({
    effort: 'high',
    maxTokens: 32 * K_TOKENS,
    use1mContext: true,
  }),
  anthropic_1m_medium: anthropicAdaptiveSettings({
    effort: 'medium',
    maxTokens: 21 * K_TOKENS,
    use1mContext: true,
  }),
  anthropic_1m_low: anthropicAdaptiveSettings({
    effort: 'low',
    maxTokens: 16 * K_TOKENS,
    use1mContext: true,
  }),
  anthropic_cm_default: anthropicAdaptiveSettings({
    effort: 'high',
    maxTokens: 32 * K_TOKENS,
    useContextManagement: true,
  }),
  anthropic_cm_high: anthropicAdaptiveSettings({
    effort: 'high',
    maxTokens: 32 * K_TOKENS,
    useContextManagement: true,
  }),
  anthropic_cm_medium: anthropicAdaptiveSettings({
    effort: 'medium',
    maxTokens: 21 * K_TOKENS,
    useContextManagement: true,
  }),
  anthropic_cm_low: anthropicAdaptiveSettings({
    effort: 'low',
    maxTokens: 16 * K_TOKENS,
    useContextManagement: true,
  }),
  openai_default: openaiChatSettings({
    reasoningEffort: 'medium',
    maxTokens: 16 * K_TOKENS,
  }),
  openai_xhigh: openaiChatSettings({
    reasoningEffort: 'xhigh',
    maxTokens: 32 * K_TOKENS,
  }),
  openai_high: openaiChatSettings({
    reasoningEffort: 'high',
    maxTokens: 32 * K_TOKENS,
  }),
  openai_medium: openaiChatSettings({
    reasoningEffort: 'medium',
    maxTokens: 16 * K_TOKENS,
  }),
  openai_low: openaiChatSettings({
    reasoningEffort: 'low',
    maxTokens: 4 * K_TOKENS,
  }),
  openai_responses_default: openaiResponsesSettings({
    reasoningEffort: 'medium',
    maxTokens: 16 * K_TOKENS,
  }),
  openai_responses_xhigh: openaiResponsesSettings({
    reasoningEffort: 'xhigh',
    reasoningSummary: 'detailed',
    maxTokens: 64 * K_TOKENS,
  }),
  openai_responses_high: openaiResponsesSettings({
    reasoningEffort: 'high',
    reasoningSummary: 'detailed',
    maxTokens: 32 * K_TOKENS,
  }),
  openai_responses_medium: openaiResponsesSettings({
    reasoningEffort: 'medium',
    maxTokens: 16 * K_TOKENS,
  }),
  openai_responses_low: openaiResponsesSettings({
    reasoningEffort: 'low',
    reasoningSummary: 'concise',
    maxTokens: 8 * K_TOKENS,
  }),
  deepseek_default: deepseekSettings({
    reasoningEffort: 'high',
    maxTokens: 128 * K_TOKENS,
  }),
  deepseek_high: deepseekSettings({
    reasoningEffort: 'high',
    maxTokens: 128 * K_TOKENS,
  }),
  deepseek_max: deepseekSettings({
    reasoningEffort: 'max',
    maxTokens: 384 * K_TOKENS,
  }),
  deepseek_off: deepseekSettings({
    thinkingEnabled: false,
    maxTokens: 128 * K_TOKENS,
  }),
  gemini_default: geminiSettings(16 * K_TOKENS, 16 * K_TOKENS),
  gemini_high: geminiSettings(32 * K_TOKENS, 21 * K_TOKENS),
  gemini_medium: geminiSettings(16 * K_TOKENS, 16 * K_TOKENS),
  gemini_low: geminiSettings(4 * K_TOKENS, 8 * K_TOKENS),
};

const PRESET_ALIASES: Record<string, string> = {
  anthropic: ModelSettingsPreset.ANTHROPIC_DEFAULT,
  anthropic_1m: ModelSettingsPreset.ANTHROPIC_1M_DEFAULT,
  anthropic_cm: ModelSettingsPreset.ANTHROPIC_CM_DEFAULT,
  openai: ModelSettingsPreset.OPENAI_DEFAULT,
  openai_responses: ModelSettingsPreset.OPENAI_RESPONSES_DEFAULT,
  deepseek: ModelSettingsPreset.DEEPSEEK_DEFAULT,
  gemini: ModelSettingsPreset.GEMINI_DEFAULT,
  high: ModelSettingsPreset.ANTHROPIC_HIGH,
  medium: ModelSettingsPreset.ANTHROPIC_MEDIUM,
  low: ModelSettingsPreset.ANTHROPIC_LOW,
};

/**
 * 按名称获取 ModelSettings 预设。
 *
 * Args:
 *   preset: 预设名字符串。
 *
 * Returns:
 *   对应的 ModelSettings 字典。
 */
export function getModelSettings(preset: string): ModelSettings {
  const name = PRESET_ALIASES[preset] ?? preset;
  const settings = PRESET_REGISTRY[name];
  if (settings === undefined) {
    const available = listPresets();
    throw new Error(
      `Unknown preset: ${preset}. Available: ${available.join(', ')}`,
    );
  }
  return structuredClone(settings);
}

/**
 * 解析预设名或字典为 ModelSettings。
 */
export function resolveModelSettings(
  presetOrDict: string | ModelSettings | null | undefined,
): ModelSettings | null {
  if (presetOrDict === null || presetOrDict === undefined) {
    return null;
  }
  if (typeof presetOrDict === 'string') {
    return getModelSettings(presetOrDict);
  }
  return { ...presetOrDict };
}

/**
 * 列出所有可用的预设名, 包含别名。
 */
export function listPresets(): string[] {
  return [
    ...new Set([
      ...Object.keys(PRESET_REGISTRY),
      ...Object.keys(PRESET_ALIASES),
    ]),
  ].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
