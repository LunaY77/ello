/**
 * 本文件负责 tool feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import path from 'node:path';

import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';
import { loadCodingAgentConfig } from '../config/index.js';
import type { TaskBoardStore } from '../task/index.js';

import { createProductionToolRuntime } from './internal/production.js';

interface ToolContext {
  readonly taskBoards: TaskBoardStore;
}

/** tool catalog 使用真实 production runtime，避免展示与执行权限配置漂移。 */
const toolHandlers = {
  'tool/list': async (context, params) => {
    const config = await loadCodingAgentConfig({ cwd: params.cwd });
    const runtime = createProductionToolRuntime({
      config,
      taskBoards: context.taskBoards,
      taskBoardScope: {
        type: 'session',
        sessionId: params.threadId ?? `catalog:${path.resolve(params.cwd)}`,
      },
      mode: () => ({
        mode: config.initial_mode,
        previousMode: null,
        source: 'config',
        changedAt: new Date().toISOString(),
      }),
    });
    return {
      data: runtime.tools.map((tool) => ({
        id: tool.name,
        name: tool.name,
        description: tool.description,
        enabled: true,
        metadata: {
          execution: tool.execution,
          risk: tool.discovery.risk,
          aliases: [...tool.discovery.aliases],
        },
      })),
    };
  },
} satisfies FeatureHandlerMap<ToolContext, 'tool/list'>;

/**
 * 构造 工具 route 适配 模块 中的 `createToolRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `taskBoards`: `createToolRoutes` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createToolRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createToolRoutes(
  taskBoards: TaskBoardStore,
): RpcRouteFragment<'tool/list'> {
  return {
    'tool/list': bindFeatureRoute(
      toolHandlers,
      () => ({ taskBoards }),
      'tool/list',
    ),
  };
}
