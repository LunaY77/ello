/**
 * 环境 feature 的唯一跨 feature 入口。
 *
 * 导出的实现覆盖本地环境、产品运行环境和资源 registry；engine contract 保持在 agent engine 内。
 */
export { createLocalEnvironment } from './local.js';
export { createRuntimeEnvironment } from './runtime.js';
export { DefaultAgentResourceRegistry } from './resources.js';
export type { CreateLocalEnvironmentOptions } from './contracts.js';
