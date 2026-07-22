/**
 * 本文件负责 config feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { pathExists } from '../../infra/filesystem.js';
import { jsonClone } from '../../protocol/json-value.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';
import {
  describeConfigSettings,
  ensureGlobalConfig,
  ensureProjectConfig,
  globalConfigPath,
  loadCodingAgentConfig,
  loadConfigSources,
  projectConfigPath,
  writeConfigPath,
} from '../config/index.js';

import { sanitizeConfigForResponse } from './response.js';

type ConfigMethod =
  | 'config/read'
  | 'config/settings'
  | 'config/write'
  | 'config/init'
  | 'config/sources';

/** config handler 在响应边界统一脱敏，credential 不进入任何 RPC 返回值。 */
const configHandlers = {
  'config/read': async (_context, params) => {
    const config = sanitizeConfigForResponse(
      jsonClone(await loadCodingAgentConfig({ cwd: params.cwd })),
    );
    if (!params.includeSources) return { config };
    const sources = await loadConfigSources(params.cwd);
    return {
      config,
      sources: await Promise.all(
        sources.map(async (source) => ({
          name: source.name,
          path: source.path ?? null,
          exists:
            source.path === undefined ? true : await pathExists(source.path),
          value: sanitizeConfigForResponse(jsonClone(source.data)),
        })),
      ),
    };
  },
  'config/settings': async (_context, params) => {
    const [config, sources] = await Promise.all([
      loadCodingAgentConfig({ cwd: params.cwd }),
      loadConfigSources(params.cwd),
    ]);
    return {
      data: describeConfigSettings(
        sanitizeConfigForResponse(jsonClone(config)),
        sources,
      ),
    };
  },
  'config/write': async (_context, params) => {
    const config = await writeConfigPath(
      params.cwd,
      params.source,
      params.path,
      params.operation === 'set'
        ? { type: 'set', value: params.value }
        : { type: 'delete' },
    );
    return { config: sanitizeConfigForResponse(jsonClone(config)) };
  },
  'config/init': async (_context, params) => {
    await ensureGlobalConfig({ force: params.force });
    await ensureProjectConfig(params.cwd, { force: params.force });
    return { created: [globalConfigPath(), projectConfigPath(params.cwd)] };
  },
  'config/sources': async (_context, params) => {
    const sources = await loadConfigSources(params.cwd);
    return {
      data: await Promise.all(
        sources.map(async (source) => ({
          name: source.name,
          path: source.path ?? null,
          exists:
            source.path === undefined ? true : await pathExists(source.path),
        })),
      ),
    };
  },
} satisfies FeatureHandlerMap<void, ConfigMethod>;

/**
 * 构造 配置 route 适配 模块 中的 `createConfigRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createConfigRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 配置 route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createConfigRoutes(): RpcRouteFragment<ConfigMethod> {
  const bind = <M extends ConfigMethod>(method: M) =>
    bindFeatureRoute(configHandlers, () => undefined, method);
  return {
    'config/read': bind('config/read'),
    'config/settings': bind('config/settings'),
    'config/write': bind('config/write'),
    'config/init': bind('config/init'),
    'config/sources': bind('config/sources'),
  };
}
