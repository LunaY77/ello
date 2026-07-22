/**
 * 本文件负责 model feature 的“transforms”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash } from 'node:crypto';

import type { JSONValue } from 'ai';

import { isRecord } from '../../../../protocol/json-value.js';
import {
  createAgentMessage,
  joinSystemCacheSegments,
  splitSystemCacheSegments,
  type AgentMessage,
  type AgentModelSettings,
  type AgentProviderOptionObject,
  type AgentProviderOptions,
  type ModelInput,
} from '../../../agent/engine/index.js';

import type { ModelModality, RuntimeModel, RuntimeRoleModel } from './types.js';

/**
 * 从 role binding 和模型能力派生 AI SDK modelSettings。
 *
 * Args:
 * - `binding`: `modelSettingsFromRole` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `modelSettingsFromRole` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function modelSettingsFromRole(
  binding: RuntimeRoleModel,
): AgentModelSettings {
  const { model, settings } = binding;
  return {
    ...(settings.reasoningEffort !== undefined && model.capabilities.reasoning
      ? { reasoning: settings.reasoningEffort }
      : {}),
    ...(settings.temperature !== undefined && model.capabilities.temperature
      ? { temperature: settings.temperature }
      : {}),
    ...(settings.topP !== undefined ? { topP: settings.topP } : {}),
    ...(settings.topK !== undefined ? { topK: settings.topK } : {}),
  };
}

/**
 * 根据模型 catalog 能力生成本轮 providerOptions。
 *
 * Args:
 * - `binding`: `providerOptionsForRole` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
 */
export function providerOptionsForRole(
  binding: RuntimeRoleModel,
): AgentProviderOptions | undefined {
  const options = {
    ...binding.model.options,
    ...(binding.settings.providerOptions ?? {}),
  };
  return Object.keys(options).length > 0
    ? parseAgentProviderOptions(options, 'model provider options')
    : undefined;
}

/**
 * 在请求发给 AI SDK 前做产品层 provider transform。
 *
 * 这里不在 `@ello/agent` 内核里硬编码厂商方言，而是根据 coding-agent 的
 * RuntimeModel catalog 做两类收敛：
 * - 模型不支持 tool call 时清空工具，避免上游收到无效工具 schema；
 * - 模型不支持图片、音频或 PDF 时，把对应 part 替换成可读占位文本。
 *
 * Args:
 * - `model`: `prepareModelInputForRuntimeModel` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `input`: `prepareModelInputForRuntimeModel` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 * - `cache`: `prepareModelInputForRuntimeModel` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `prepareModelInputForRuntimeModel` 计算出的声明结果；返回值不包含未声明的兜底状态。
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
  const providerOptions = input.providerOptions;
  const openai = providerOptions?.openai;
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
      ...(providerOptions === undefined ? {} : providerOptions),
      openai: {
        ...(openai === undefined ? {} : openai),
        promptCacheKey,
      },
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
  const providerOptionsValue = Reflect.get(message, 'providerOptions');
  const providerOptions =
    providerOptionsValue === undefined
      ? undefined
      : parseAgentProviderOptions(
          providerOptionsValue,
          'message provider options',
        );
  const anthropic = providerOptions?.anthropic;
  if (
    anthropic?.cacheControl !== undefined ||
    anthropic?.cache_control !== undefined
  ) {
    throw new Error('Anthropic message cache policy is owned by coding-agent.');
  }
  return createAgentMessage({
    ...message,
    providerOptions: {
      ...(providerOptions === undefined ? {} : providerOptions),
      anthropic: {
        ...(anthropic === undefined ? {} : anthropic),
        // 会话前沿每轮推进，使用 5m TTL 控制高频写入成本。
        cacheControl: { type: 'ephemeral', ttl: '5m' },
      },
    },
  });
}

function parseAgentProviderOptions(
  value: unknown,
  name: string,
): AgentProviderOptions {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const options: AgentProviderOptions = {};
  for (const [provider, providerValue] of Object.entries(value)) {
    options[provider] = parseProviderOptionObject(
      providerValue,
      `${name}.${provider}`,
    );
  }
  return options;
}

function parseProviderOptionObject(
  value: unknown,
  name: string,
): AgentProviderOptionObject {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const result: AgentProviderOptionObject = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = parseJsonValue(entry, `${name}.${key}`);
  }
  return result;
}

function parseJsonValue(value: unknown, name: string): JSONValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${name} must be a finite JSON number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parseJsonValue(entry, `${name}[${index}]`),
    );
  }
  if (isRecord(value)) {
    const result: Record<string, JSONValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = parseJsonValue(entry, `${name}.${key}`);
    }
    return result;
  }
  throw new Error(`${name} must be JSON serializable.`);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stripUnsupportedParts(
  model: RuntimeModel,
  message: AgentMessage,
): AgentMessage {
  const content = Reflect.get(message, 'content');
  if (!Array.isArray(content)) {
    return message;
  }

  let changed = false;
  const parts: ReadonlyArray<unknown> = content;
  const next = parts.map((part) => {
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

  return changed ? createAgentMessage({ ...message, content: next }) : message;
}

function modalityForPart(part: unknown): ModelModality | undefined {
  if (typeof part !== 'object' || part === null) {
    return undefined;
  }
  const type = Reflect.get(part, 'type');
  if (type === 'image') {
    return 'image';
  }
  if (type === 'audio') {
    return 'audio';
  }
  const mediaType = Reflect.get(part, 'mediaType');
  if (
    type === 'file' &&
    typeof mediaType === 'string' &&
    mediaType.includes('pdf')
  ) {
    return 'pdf';
  }
  return undefined;
}
