import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export type AiSdkLanguageModelEndpoint =
  | 'languageModel'
  | 'chat'
  | 'responses'
  | 'custom';

export type AiSdkProviderKind = 'openai' | 'anthropic' | 'openai-compatible';

export interface AiSdkLanguageModelDescriptor {
  /** provider 标识仅用于诊断和 AI SDK provider name，不参与产品层选择策略。 */
  readonly providerId: string;
  /** AI SDK provider 类型；包名和 factory 映射是框架内部实现细节。 */
  readonly providerKind: AiSdkProviderKind;
  /** provider 真实模型 ID，不等同于产品层 profile 名。 */
  readonly modelId: string;
  /** 调用端点；OpenAI-compatible chat/responses 的差异在这里表达。 */
  readonly endpoint: AiSdkLanguageModelEndpoint;
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly options?: Record<string, unknown>;
}

/**
 * 根据 AI SDK provider descriptor 创建 LanguageModel。
 *
 * 这是框架层和 AI SDK provider 包的边界：产品层可以维护 catalog、profile、
 * auth 和 capability。
 * 新 provider 类型只需要在这里扩展映射，`@ello/agent` 的调用循环仍只接收
 * 标准 `LanguageModel`。
 */
export function createAiSdkLanguageModel(
  descriptor: AiSdkLanguageModelDescriptor,
): LanguageModel {
  const options = {
    name: descriptor.providerId,
    ...(descriptor.baseURL !== undefined
      ? { baseURL: descriptor.baseURL }
      : {}),
    ...(descriptor.apiKey !== undefined ? { apiKey: descriptor.apiKey } : {}),
    ...(descriptor.headers !== undefined
      ? { headers: descriptor.headers }
      : {}),
    ...(descriptor.options ?? {}),
  };

  if (descriptor.providerKind === 'anthropic') {
    const anthropic = createAnthropic(
      options as Parameters<typeof createAnthropic>[0],
    );
    return anthropic.languageModel(
      descriptor.modelId as Parameters<typeof anthropic.languageModel>[0],
    );
  }

  if (
    descriptor.providerKind === 'openai' ||
    descriptor.providerKind === 'openai-compatible'
  ) {
    const openai = createOpenAI(options as Parameters<typeof createOpenAI>[0]);
    if (descriptor.endpoint === 'chat') {
      return openai.chat(
        descriptor.modelId as Parameters<typeof openai.chat>[0],
      );
    }
    if (descriptor.endpoint === 'responses') {
      return openai.responses(
        descriptor.modelId as Parameters<typeof openai.responses>[0],
      );
    }
    return openai.languageModel(
      descriptor.modelId as Parameters<typeof openai.languageModel>[0],
    );
  }

  throw new Error(
    `Unsupported AI SDK provider kind: ${descriptor.providerKind} (${descriptor.providerId})`,
  );
}
