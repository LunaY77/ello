/**
 * 单次产品 Agent 装配使用的 Memory 工具、索引缓存和仓储生命周期。
 *
 * 启用状态由配置边界决定；启用后工具 mutation 与索引失效共享同一串行队列，调用方必须在读取
 * `tools` 或 `indexLoader` 前完成 `initialize()`。
 */
import type { AnyAgentTool } from '../agent/engine/index.js';
import type { CodingAgentConfig } from '../config/index.js';
import { markCoreTool, type ApprovalFor } from '../tool/index.js';

import { MemoryIndexLoader } from './internal/index-loader.js';
import { memoryRoots } from './internal/paths.js';
import { createMemoryStore } from './internal/store.js';
import { createMemoryTools } from './internal/tools.js';

export type MemoryRunRuntime =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly tools: ReadonlyArray<AnyAgentTool>;
      readonly indexLoader: MemoryIndexLoader;
      /**
       * 初始化 Memory `runtime` 模块 所需的目录、连接或缓存；完成前不得使用依赖这些资源的操作。
       *
       * Args:
       * - 无：操作使用实例或闭包已经持有的稳定状态。
       *
       * Returns:
       * - Promise 在依赖资源全部可用后兑现；兑现前实例仍视为未就绪。
       *
       * Throws:
       * - 当 Memory `runtime` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
       */
      initialize(): Promise<void>;
    };

/**
 * 创建与一次产品 Agent 构建对应的 Memory runtime。
 *
 * Args:
 * - `config`: 已解析的运行配置；Memory 根目录和禁用工具名单均从该稳定快照读取。
 * - `approval`: Tool feature 基于当前 permission session 创建的审批回调工厂。
 *
 * Returns:
 * - Memory 关闭时返回显式 disabled 分支；启用时返回共享仓储的工具、索引 loader 和初始化函数。
 */
export function createMemoryRunRuntime(
  config: CodingAgentConfig,
  approval: ApprovalFor,
): MemoryRunRuntime {
  if (!config.context.memory.enabled) {
    return { enabled: false };
  }
  const repository = createMemoryStore(memoryRoots(config));
  const indexLoader = new MemoryIndexLoader(repository);
  let mutationQueue: Promise<void> = Promise.resolve();
  const tools = createMemoryTools({
    approval,
    port: {
      repository,
      mutate<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
        const result = mutationQueue.then(operation);
        mutationQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result.then((value) => {
          indexLoader.invalidate();
          return value;
        });
      },
    },
  })
    .filter((tool) => !config.tools.disabled.includes(tool.name))
    .map(markCoreTool);
  return {
    enabled: true,
    tools,
    indexLoader,
    initialize: () => repository.initialize(),
  };
}
