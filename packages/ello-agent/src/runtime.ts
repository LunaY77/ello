/**
 * `@ello/agent/runtime` 提供 App Server 外部运行时装配所需的最小公开端口。
 *
 * 调用方可提供每个 Agent run 的环境和 tracing，并使用与 server entry 相同的 listener 生命周期。
 */
export { createLocalEnvironment } from './features/environment/index.js';
export { listenEndpoint } from './server/transport/listeners.js';
export type { CreateAppOptions } from './app.js';
export type {
  AgentEnvironmentInput,
  AgentRuntime,
  AgentTracing,
  CreateAgentEnvironment,
  CreateAgentTracing,
  PermissionSessionView,
} from './features/agent/contracts.js';
export type {
  AgentEnvironment,
  AgentFileSystem,
  AgentResource,
  AgentResourceFactory,
  AgentResourceRegistry,
  AgentShell,
  AgentShellResult,
} from './features/agent/engine/contracts.js';
export type { AgentEventRecorder } from './features/agent/engine/events.js';
export type { CreateLocalEnvironmentOptions } from './features/environment/index.js';
export type {
  ListenerOptions,
  ServerListener,
} from './server/transport/listeners.js';
