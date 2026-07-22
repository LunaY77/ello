/**
 * 本文件负责 fs feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { ArtifactStore } from '../artifact/index.js';

import { createFsRoutes, type FsWatchers } from './routes.js';

/**
 * 构造 文件系统 公开入口 模块 中的 `createFsFeature` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `artifacts`: `createFsFeature` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createFsFeature` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 文件系统 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createFsFeature(artifacts: ArtifactStore) {
  const watchers: FsWatchers = new Map();
  return {
    routes: createFsRoutes({ artifacts, watchers }),
    releaseConnection(connectionId: string): void {
      for (const [watchId, owned] of watchers) {
        if (owned.connectionId !== connectionId) continue;
        owned.watcher.close();
        watchers.delete(watchId);
      }
    },
    /**
     * 停止 文件系统 公开入口 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
     *
     * Throws:
     * - 当 文件系统 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    close(): Promise<void> {
      for (const { watcher } of watchers.values()) watcher.close();
      watchers.clear();
      return Promise.resolve();
    },
  };
}
