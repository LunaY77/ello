/**
 * 本文件声明模型目录对上层 Agent 暴露的稳定运行时契约。
 *
 * 配置层字段在进入该边界后统一转为 TypeScript 命名，不携带可变 provider 状态。
 */
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
  /** 按稳定名称顺序列出全部已配置模型。 */
  listModels(): readonly RuntimeModel[];
  /** 按配置名称读取模型，不存在时明确失败。 */
  getModel(modelName: string): RuntimeModel;
  /** 创建指定配置模型对应的 AI SDK 语言模型。 */
  resolveLanguageModel(modelName: string): AgentModel;
  /** 将 primary/auxiliary 角色解析为具体运行时模型。 */
  resolveSelector(selector: AgentModelSelector): RuntimeModel;
}
