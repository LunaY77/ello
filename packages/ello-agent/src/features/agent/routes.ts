/**
 * 本文件负责 agent feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';
import { loadCodingAgentConfig, writeConfigPath } from '../config/index.js';

import { createAgentRegistry } from './subagents/registry.js';

/** agent catalog 明确区分 primary、可委派 subagent 与内部 agent。 */
const agentHandlers = {
  'agent/list': async (_context, params) => {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    const registry = await createAgentRegistry(config);
    return {
      data: registry.list().map((agent) => {
        const primaryAvailable =
          agent.hidden !== true &&
          (agent.mode === 'primary' || agent.mode === 'all');
        const delegationAvailable =
          agent.hidden !== true &&
          (agent.mode === 'subagent' || agent.mode === 'all');
        return {
          id: agent.name,
          name: agent.name,
          description: agent.description,
          enabled: primaryAvailable || delegationAvailable,
          metadata: {
            mode: agent.mode,
            model: agent.model,
            source: agent.source,
            runtime: primaryAvailable
              ? 'primary'
              : delegationAvailable
                ? 'delegation'
                : 'internal-only',
          },
        };
      }),
    };
  },
  'agent/effort/update': async (_context, params) => {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    const definition = (await createAgentRegistry(config)).get(params.agent);
    const selector = definition.model;
    const model = config[selector];
    await writeConfigPath(
      params.cwd,
      'global',
      ['models', model, 'reasoning_effort'],
      { type: 'set', value: params.effort },
    );
    return { agent: definition.name, selector, model, effort: params.effort };
  },
} satisfies FeatureHandlerMap<void, 'agent/list' | 'agent/effort/update'>;

/**
 * 构造 产品 Agent route 适配 模块 中的 `createAgentRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createAgentRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createAgentRoutes(): RpcRouteFragment<
  'agent/list' | 'agent/effort/update'
> {
  return {
    'agent/list': bindFeatureRoute(
      agentHandlers,
      () => undefined,
      'agent/list',
    ),
    'agent/effort/update': bindFeatureRoute(
      agentHandlers,
      () => undefined,
      'agent/effort/update',
    ),
  };
}
