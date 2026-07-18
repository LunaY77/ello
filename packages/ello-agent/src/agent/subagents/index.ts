/**
 * agents 模块公开出口。
 *
 * Server 使用的 agent registry、background job 和权限派生。
 */
export { builtinAgents } from './builtin.js';
export { loadMarkdownAgents } from './markdown-loader.js';
export { createAgentRegistry, type AgentRegistry } from './registry.js';
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
