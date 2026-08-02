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

import { createModelRegistry } from './providers/catalog/index.js';

type ModelMethod = 'model/list';

/** model catalog 把 provider 内部描述投影为稳定的公开 CatalogEntry。 */
const modelHandlers = {
  'model/list': async (_context, params) => {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    return {
      data: createModelRegistry(config)
        .listModels()
        .map((model) => ({
          id: model.name,
          name: model.name,
          title: model.apiModel,
          enabled: true,
          metadata: {
            protocol: model.protocol,
            apiModel: model.apiModel,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            selector:
              config.primary_model === model.name
                ? 'primary_model'
                : config.auxiliary_model === model.name
                  ? 'auxiliary_model'
                  : null,
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
  };
}
