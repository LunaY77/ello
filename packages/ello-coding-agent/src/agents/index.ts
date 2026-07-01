/**
 * agents 模块公开出口。
 *
 * 产品级 agent 编排：registry（builtin/config/markdown 合并）、agent-runner
 * （由定义构建 Agent）、sidechain subagent 委派、background job、权限派生。
 * 这些都是产品概念，框架 `@ello/agent` 不表达。
 */
export { builtinAgents } from './builtin.js';
export { loadMarkdownAgents } from './markdown-loader.js';
export { createAgentRegistry, type AgentRegistry } from './registry.js';
export {
  runInternalAgent,
  createSubagentAgent,
  type SubagentAgentDeps,
} from './agent-runner.js';
export {
  runSubagent,
  type SubagentRun,
  type SubagentRunDeps,
} from './subagent-run.js';
export {
  createDelegateTool,
  renderSubagentEnvelope,
  type CreateDelegateToolOptions,
  type DelegateToolHooks,
} from './delegate-tool.js';
export {
  BackgroundJobStore,
  type BackgroundJob,
  type BackgroundJobDescriptor,
  type BackgroundJobHandle,
} from './background-jobs.js';
export { deriveSubagentPermission } from './subagent-permissions.js';
export {
  agentDefinitionFromConfigEntry,
  agentDefinitionFromMarkdown,
  MarkdownAgentFrontmatterSchema,
  type CodingAgentDefinition,
  type CodingAgentMode,
  type CodingAgentSource,
  type MarkdownAgentFrontmatter,
} from './schema.js';
