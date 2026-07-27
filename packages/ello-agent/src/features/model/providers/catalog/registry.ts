import type { AgentModel } from '../../../agent/engine/index.js';
import type { CodingAgentConfig } from '../../../config/index.js';
import { createAiSdkLanguageModel } from '../ai-sdk/ai-sdk-provider.js';

import type { ModelRegistry, RuntimeModel } from './types.js';

export function createModelRegistry(config: CodingAgentConfig): ModelRegistry {
  return new DefaultModelRegistry(config);
}

class DefaultModelRegistry implements ModelRegistry {
  private readonly models: Map<string, RuntimeModel>;

  constructor(private readonly config: CodingAgentConfig) {
    this.models = new Map(
      Object.entries(config.models).map(([name, model]) => [
        name,
        {
          name,
          protocol: model.protocol,
          ...(model.protocol === 'anthropic'
            ? {}
            : { endpoint: model.endpoint }),
          apiModel: model.api_model,
          baseUrl: model.base_url,
          apiKeyEnv: model.api_key_env,
          apiKey: requireApiKey(model.api_key_env),
          ...(model.http_headers === undefined
            ? {}
            : { httpHeaders: model.http_headers }),
          ...(model.protocol === 'anthropic'
            ? { authScheme: model.auth_scheme }
            : {}),
          contextWindow: model.context_window,
          maxOutputTokens: model.max_output_tokens,
          reasoningEffort: model.reasoning_effort,
        },
      ]),
    );
  }

  listModels(): readonly RuntimeModel[] {
    return [...this.models.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  getModel(modelName: string): RuntimeModel {
    const model = this.models.get(modelName);
    if (model === undefined) {
      throw new Error(`Unknown model: ${modelName}`);
    }
    return model;
  }

  resolveLanguageModel(modelName: string): AgentModel {
    const model = this.getModel(modelName);
    return createAiSdkLanguageModel({
      protocol: model.protocol,
      ...(model.endpoint === undefined ? {} : { endpoint: model.endpoint }),
      modelId: model.apiModel,
      baseURL: model.baseUrl,
      apiKey: model.apiKey,
      ...(model.httpHeaders === undefined
        ? {}
        : { headers: model.httpHeaders }),
      ...(model.authScheme === undefined
        ? {}
        : { authScheme: model.authScheme }),
    });
  }

  resolveSelector(selector: 'primary_model' | 'auxiliary_model'): RuntimeModel {
    return this.getModel(this.config[selector]);
  }
}

function requireApiKey(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Required model credential is missing or empty: ${name}`);
  }
  return value;
}
