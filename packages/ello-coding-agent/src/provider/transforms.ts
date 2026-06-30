import type { AgentMessage, ModelInput } from '@ello/agent';

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
): ModelInput {
  const messages = input.messages.map((message) =>
    stripUnsupportedParts(model, message),
  );
  const messagesChanged = messages.some(
    (message, index) => message !== input.messages[index],
  );
  if (model.capabilities.toolCall && !messagesChanged) {
    return input;
  }
  return {
    ...input,
    messages,
    ...(model.capabilities.toolCall
      ? {}
      : { tools: {}, activeTools: [] as readonly string[] }),
  };
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
