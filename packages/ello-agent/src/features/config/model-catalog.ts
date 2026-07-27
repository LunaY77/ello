/** Built-in configuration is a complete, credential-free model directory. */
import type { ModelConfig } from './schema.js';

export interface BuiltinModelConfig {
  readonly models: Record<string, ModelConfig>;
  readonly primary_model: string;
  readonly auxiliary_model: string;
}

export const builtinModelConfig: BuiltinModelConfig = {
  models: {
    'openai-gpt-5.5': {
      protocol: 'openai',
      endpoint: 'responses',
      api_model: 'gpt-5.5',
      base_url: 'https://api.openai.com/v1',
      api_key_env: 'OPENAI_API_KEY',
      context_window: 400_000,
      max_output_tokens: 32_000,
      reasoning_effort: 'high',
    },
    'openai-gpt-5.4': {
      protocol: 'openai',
      endpoint: 'responses',
      api_model: 'gpt-5.4',
      base_url: 'https://api.openai.com/v1',
      api_key_env: 'OPENAI_API_KEY',
      context_window: 400_000,
      max_output_tokens: 16_000,
      reasoning_effort: 'low',
    },
  },
  primary_model: 'openai-gpt-5.5',
  auxiliary_model: 'openai-gpt-5.4',
};
