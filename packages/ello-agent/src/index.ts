/**
 * `@ello/agent` 的公共入口。
 *
 * 这里是 provider 无关 Agent 内核对外的稳定门面：只重导出供产品层使用的工厂
 * 函数（`createAgent`、`defineTool`、技能/子代理/环境构造器）与全部公共类型。
 * 内部实现细节不从此处暴露——需要触达内核内部的高级用法请走 `./internal.js`。
 * 同时重导出 `zod` 的 `z`，方便调用方定义工具输入 schema 时无需另装依赖。
 */
export { createAgent } from './public/create-agent.js';
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
  loadSkillsFromDir,
  skillIndexContext,
} from './core/skills.js';
export { createDelegateTool, defineSubagent } from './core/subagent.js';
export type { CreateDelegateToolOptions } from './core/subagent.js';
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
  AgentSetupContext,
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
  ModelInput,
  ModelInputDiagnostics,
  PrepareModelInput,
  ProviderOptionsResolver,
  QueueDrainDiagnostic,
  SessionCompactionReport,
  SessionCompactor,
  SessionStore,
  SubagentDefinition,
  SubagentRunSummary,
  SystemSection,
  MessageTransform,
  UserMessage,
} from './public/types.js';
export type { AgentStreamEvent } from './public/events.js';
export type {
  CreateLocalEnvironmentOptions,
  DefaultAgentResourceRegistry,
} from './environment/index.js';
