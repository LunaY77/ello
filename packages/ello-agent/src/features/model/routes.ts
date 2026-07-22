/**
 * 本文件负责 model feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';
import { loadCodingAgentConfig } from '../config/index.js';

import { createProviderRegistry } from './providers/catalog/index.js';

type ModelMethod = 'model/list' | 'provider/list';

/** model catalog 把 provider 内部描述投影为稳定的公开 CatalogEntry。 */
const modelHandlers = {
  'model/list': async (_context, params) => {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    return {
      data: createProviderRegistry(config)
        .listModels()
        .map((model) => ({
          id: model.ref,
          name: model.name,
          title: model.ref,
          enabled: model.status === 'active',
          metadata: {
            provider: model.providerId,
            status: model.status,
            context: model.limit.context,
            output: model.limit.output,
            toolCall: model.capabilities.toolCall,
            reasoning: model.capabilities.reasoning,
          },
        })),
    };
  },
  'provider/list': async (_context, params) => {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    return {
      data: createProviderRegistry(config)
        .listProviders()
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          metadata: {
            kind: provider.kind,
            source: provider.source,
            apiKeyConfigured: provider.apiKey !== undefined,
            baseUrlConfigured: provider.baseUrl !== undefined,
          },
        })),
    };
  },
} satisfies FeatureHandlerMap<void, ModelMethod>;

/**
 * 构造 模型 route 适配 模块 中的 `createModelRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createModelRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 模型 route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createModelRoutes(): RpcRouteFragment<ModelMethod> {
  const bind = <M extends ModelMethod>(method: M) =>
    bindFeatureRoute(modelHandlers, () => undefined, method);
  return {
    'model/list': bind('model/list'),
    'provider/list': bind('provider/list'),
  };
}
