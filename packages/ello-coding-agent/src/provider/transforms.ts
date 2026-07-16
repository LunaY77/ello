import { createHash } from 'node:crypto';

import type { AgentMessage, ModelInput } from '@ello/agent';

import {
  joinSystemCacheSegments,
  splitSystemCacheSegments,
} from '../context/cache-layout.js';

import type { ModelModality, RuntimeModel, RuntimeRoleModel } from './types.js';

/** 根据模型 catalog 能力生成本轮 providerOptions。 */
export function providerOptionsForRole(
  binding: RuntimeRoleModel,
): Record<string, unknown> | undefined {
  const options = {
    ...binding.model.options,
    ...(binding.settings.providerOptions ?? {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * 在请求发给 AI SDK 前做产品层 provider transform。
 *
 * 这里不在 `@ello/agent` 内核里硬编码厂商方言，而是根据 coding-agent 的
 * RuntimeModel catalog 做两类收敛：
 * - 模型不支持 tool call 时清空工具，避免上游收到无效工具 schema；
 * - 模型不支持图片、音频或 PDF 时，把对应 part 替换成可读占位文本。
 */
export function prepareModelInputForRuntimeModel(
  model: RuntimeRoleModel['model'],
  input: ModelInput,
  cache: {
    readonly promptProfile: string;
    readonly cwdIdentity: string;
  },
): ModelInput {
  const messages = input.messages.map((message) =>
    stripUnsupportedParts(model, message),
  );
  const transformed: ModelInput = {
    ...input,
    messages,
  };
  const cacheSegments =
    transformed.system === undefined
      ? { stable: '', dynamic: '' }
      : splitSystemCacheSegments(transformed.system);
  const normalized = {
    ...transformed,
    ...(transformed.system !== undefined
      ? { system: joinSystemCacheSegments(cacheSegments) }
      : {}),
  };
  if (model.providerKind === 'anthropic') {
    return addAnthropicCacheBreakpoints(normalized, cacheSegments);
  }
  if (
    model.providerKind === 'openai' ||
    model.providerKind === 'openai-compatible'
  ) {
    return addOpenAiPromptCacheKey(model, normalized, cache, cacheSegments);
  }
  return normalized;
}

function addOpenAiPromptCacheKey(
  model: RuntimeModel,
  input: ModelInput,
  cache: {
    readonly promptProfile: string;
    readonly cwdIdentity: string;
  },
  cacheSegments: { readonly stable: string; readonly dynamic: string },
): ModelInput {
  if (input.diagnostics === undefined) {
    throw new Error('Model input diagnostics are required for prompt caching.');
  }
  const providerOptions = input.providerOptions ?? {};
  const openai = optionalOptionsRecord(providerOptions.openai, 'openai');
  const toolsetFingerprint = model.capabilities.toolCall
    ? input.diagnostics.toolsetFingerprint
    : hash('[]');
  const promptCacheKey = hash(
    [
      model.providerId,
      model.id,
      cache.promptProfile,
      cache.cwdIdentity,
      toolsetFingerprint,
      hash(cacheSegments.stable),
    ].join('\n'),
  );
  return {
    ...input,
    providerOptions: {
      ...providerOptions,
      openai: { ...openai, promptCacheKey },
    },
  };
}

function addAnthropicCacheBreakpoints(
  input: ModelInput,
  cacheSegments: { readonly stable: string; readonly dynamic: string },
): ModelInput {
  if (input.system === undefined || cacheSegments.stable === '') {
    throw new Error('Anthropic cache breakpoint requires a system prompt.');
  }
  const conversation = addConversationCacheBreakpoint(input.messages);
  const messages: AgentMessage[] = [
    {
      role: 'system',
      content: cacheSegments.stable,
      providerOptions: {
        // 稳定规则和工具契约使用 1h TTL，避免长时间工具执行后基础前缀失效。
        anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
    },
    ...(cacheSegments.dynamic === ''
      ? []
      : [{ role: 'system' as const, content: cacheSegments.dynamic }]),
    ...conversation,
  ];
  const { system: _system, ...withoutSystem } = input;
  return {
    ...withoutSystem,
    messages,
  };
}

function addConversationCacheBreakpoint(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  if (messages.length === 0) {
    return [];
  }
  const frontier = messages.length - 1;
  return messages.map((message, index) =>
    index === frontier ? addMessageCacheControl(message) : message,
  );
}

function addMessageCacheControl(message: AgentMessage): AgentMessage {
  const record = message as AgentMessage & {
    readonly providerOptions?: Record<string, unknown>;
  };
  const providerOptions = optionalOptionsRecord(
    record.providerOptions,
    'message',
  );
  const anthropic = optionalOptionsRecord(
    providerOptions.anthropic,
    'message.anthropic',
  );
  if (
    anthropic.cacheControl !== undefined ||
    anthropic.cache_control !== undefined
  ) {
    throw new Error('Anthropic message cache policy is owned by coding-agent.');
  }
  return {
    ...message,
    providerOptions: {
      ...providerOptions,
      anthropic: {
        ...anthropic,
        // 会话前沿每轮推进，使用 5m TTL 控制高频写入成本。
        cacheControl: { type: 'ephemeral', ttl: '5m' },
      },
    },
  } as AgentMessage;
}

function optionalOptionsRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Provider options ${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stripUnsupportedParts(
  model: RuntimeModel,
  message: AgentMessage,
): AgentMessage {
  const content = (message as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) {
    return message;
  }

  let changed = false;
  const next = content.map((part) => {
    const modality = modalityForPart(part);
    if (modality === undefined || model.capabilities.input.includes(modality)) {
      return part;
    }
    changed = true;
    return {
      type: 'text',
      text: `[ello omitted unsupported ${modality} input for ${model.ref}]`,
    };
  });

  return changed ? ({ ...message, content: next } as AgentMessage) : message;
}

function modalityForPart(part: unknown): ModelModality | undefined {
  if (typeof part !== 'object' || part === null) {
    return undefined;
  }
  const record = part as {
    readonly type?: unknown;
    readonly mediaType?: unknown;
  };
  if (record.type === 'image') {
    return 'image';
  }
  if (record.type === 'audio') {
    return 'audio';
  }
  if (
    record.type === 'file' &&
    typeof record.mediaType === 'string' &&
    record.mediaType.includes('pdf')
  ) {
    return 'pdf';
  }
  return undefined;
}
