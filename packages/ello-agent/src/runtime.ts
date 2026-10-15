/**
 * `@ello/agent/runtime` 提供 App Server 外部运行时装配所需的最小公开端口。
 *
 * 调用方可提供稳定 Environments adapter 和 tracing，并使用与 server entry 相同的 listener 生命周期。
 */
export {
  createLocalEnvironments,
  LOCAL_HOST_ENVIRONMENT_REFERENCE,
} from './features/environment/index.js';
export { listenEndpoint } from './server/transport/listeners.js';
export type { CreateAppOptions } from './app.js';
export type {
  AgentRuntime,
  AgentTracing,
  CreateAgentTracing,
  PermissionSessionView,
} from './features/agent/contracts.js';
export type { AgentEventRecorder } from './features/agent/engine/events.js';
export type * from './features/environment/index.js';
export type {
  ListenerOptions,
  ServerListener,
} from './server/transport/listeners.js';
