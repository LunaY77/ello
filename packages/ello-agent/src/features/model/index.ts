/**
 * 本文件负责 model feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createProviderRegistry } from './providers/catalog/index.js';
import { createModelRoutes } from './routes.js';

/**
 * 构造 模型 公开入口 模块 中的 `createModelFeature` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createModelFeature` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 模型 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createModelFeature() {
  return {
    resolve: createProviderRegistry,
    routes: createModelRoutes(),
  };
}

export {
  createProviderRegistry,
  modelSettingsFromRole,
  prepareModelInputForRuntimeModel,
  providerOptionsForRole,
  type ModelRole,
  type ProviderRegistry,
  type RuntimeRoleModel,
} from './providers/catalog/index.js';
export { createAiSdkModelAdapter } from './providers/ai-sdk/ai-sdk.js';
