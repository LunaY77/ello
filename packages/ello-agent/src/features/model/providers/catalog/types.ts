import type { AgentModel } from '../../../agent/engine/index.js';
import type {
  AnthropicAuthScheme,
  AgentModelSelector,
  ModelConfig,
} from '../../../config/index.js';

export type ModelProtocol = ModelConfig['protocol'];

export interface RuntimeModel {
  readonly name: string;
  readonly protocol: ModelProtocol;
  readonly apiModel: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKey: string;
  readonly httpHeaders?: Readonly<Record<string, string>>;
  /** Anthropic's credential HTTP scheme; other protocols use their wire-standard bearer scheme. */
  readonly authScheme?: AnthropicAuthScheme;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoningEffort: ModelConfig['reasoning_effort'];
  readonly endpoint?: Extract<
    ModelConfig,
    { protocol: 'openai' | 'openai-compatible' }
  >['endpoint'];
}

export interface ModelRegistry {
  listModels(): readonly RuntimeModel[];
  getModel(modelName: string): RuntimeModel;
  resolveLanguageModel(modelName: string): AgentModel;
  resolveSelector(selector: AgentModelSelector): RuntimeModel;
}
