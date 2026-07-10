/**
 * `@ello/agent` 的公共入口。
 *
 * 这里是 provider 无关 Agent 内核对外的稳定门面：只重导出供产品层使用的工厂
 * 函数（`createAgent`、`defineTool`、技能/子代理/环境构造器）与全部公共类型。
 * 内部实现细节不从包出口暴露。
 * 同时重导出 `zod` 的 `z`，方便调用方定义工具输入 schema 时无需另装依赖。
 */
export { createAgent } from './public/create-agent.js';
export {
  AgentStreamBackpressureError,
  ModelAdapterProtocolError,
} from './public/errors.js';
export { AiSdkModelAdapter } from './adapters/ai-sdk.js';
export type { AiSdkModelAdapterOptions } from './adapters/ai-sdk.js';
export { createAiSdkLanguageModel } from './adapters/ai-sdk-provider.js';
export type {
  AiSdkLanguageModelDescriptor,
  AiSdkLanguageModelEndpoint,
  AiSdkProviderKind,
} from './adapters/ai-sdk-provider.js';
export { defineTool } from './public/tool.js';
export {
  activeSkillsContext,
  createSkillTools,
  skillIndexContext,
} from './core/skills.js';
export {
  createLocalEnvironment,
  createLocalShellEnvironment,
} from './environment/index.js';
export { z } from 'zod';

export type {
  Agent,
  AgentApprovalDecision,
  AgentApprovalPolicy,
  AgentApprovalRequest,
  AgentContext,
  AgentEnvironment,
  AgentError,
  AgentEventRecorder,
  AgentFileSystem,
  AgentResource,
  AgentResourceFactory,
  AgentResourceRegistry,
  AgentFinishReason,
  AgentInput,
  AgentMessage,
  AgentModel,
  AgentObserver,
  AgentRunContext,
  AgentRunDiagnostics,
  AgentRunOptions,
  AgentRunResult,
  AgentShell,
  AgentShellResult,
  AgentSkill,
  AgentStream,
  AgentTool,
  AgentToolChoice,
  AgentToolCall,
  AgentToolContext,
  AgentToolSet,
  AgentUsage,
  AnyAgentTool,
  AssistantMessage,
  CreateAgentOptions,
  DeferredApprovalItem,
  DeferredRunItem,
  DeferredRunResults,
  DeferredToolCallItem,
  InterruptedRunItem,
  MaybePromise,
  ModelAdapter,
  ModelCallCompletedEvent,
  ModelInput,
  ModelInputDiagnostics,
  PrepareModelInput,
  ProviderOptionsResolver,
  QueueDrainDiagnostic,
  SessionCompactionReport,
  CompactionPort,
  TranscriptStore,
  SystemSection,
  MessageTransform,
  UserMessage,
} from './public/types.js';
export type { AgentStreamEvent, RunCompletedEvent } from './public/events.js';
export type {
  CreateLocalEnvironmentOptions,
  DefaultAgentResourceRegistry,
} from './environment/index.js';
