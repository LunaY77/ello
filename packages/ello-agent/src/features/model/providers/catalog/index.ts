/**
 * 本文件负责 model feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
export { createProviderRegistry } from './registry.js';
export {
  modelSettingsFromRole,
  prepareModelInputForRuntimeModel,
  providerOptionsForRole,
} from './transforms.js';
export type {
  ModelCapabilities,
  ModelEndpoint,
  ModelModality,
  ModelRole,
  ModelRoleSettings,
  ProviderRegistry,
  RuntimeModel,
  RuntimeProfileSuite,
  RuntimeProvider,
  RuntimeRoleModel,
} from './types.js';
