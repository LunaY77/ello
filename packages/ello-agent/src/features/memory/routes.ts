/**
 * 本文件负责 memory feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { invalidParams } from '../../protocol/errors.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';
import { loadCodingAgentConfig } from '../config/index.js';

import { memoryRoots } from './internal/paths.js';
import { createMemoryStore, type MemoryStore } from './internal/store.js';

type MemoryMethod = 'memory/status' | 'memory/reload' | 'memory/dream/start';

/** Memory 开关由 Server 配置唯一决定，禁用状态不创建目录或后台任务。 */
const memoryHandlers = {
  'memory/status': async (_context, params) => {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    const roots = memoryRoots(config);
    if (config.context.memory.enabled) {
      const repository = createMemoryStore(roots);
      await repository.initialize();
    }
    return {
      enabled: config.context.memory.enabled,
      state: 'idle',
      privateRoot: roots.private,
      teamRoot: roots.team,
      pendingJobs: 0,
    };
  },
  'memory/reload': async (_context, params) => {
    await memoryRepository(params.cwd);
    return { ok: true };
  },
  'memory/dream/start': async (_context, params) => {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    if (!config.context.memory.enabled) {
      throw invalidParams('Memory is disabled by Server configuration.');
    }
    throw invalidParams(
      'Memory dream is unavailable because no production dream runner is configured.',
    );
  },
} satisfies FeatureHandlerMap<void, MemoryMethod>;

/**
 * 构造 Memory route 适配 模块 中的 `createMemoryRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createMemoryRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Memory route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createMemoryRoutes(): RpcRouteFragment<MemoryMethod> {
  const bind = <M extends MemoryMethod>(method: M) =>
    bindFeatureRoute(memoryHandlers, () => undefined, method);
  return {
    'memory/status': bind('memory/status'),
    'memory/reload': bind('memory/reload'),
    'memory/dream/start': bind('memory/dream/start'),
  };
}

async function memoryRepository(cwd: string): Promise<MemoryStore> {
  const config = await loadCodingAgentConfig({ cwd });
  if (!config.context.memory.enabled) {
    throw invalidParams('Memory is disabled by Server configuration.');
  }
  const repository = createMemoryStore(memoryRoots(config));
  await repository.initialize();
  return repository;
}
