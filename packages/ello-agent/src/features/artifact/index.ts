/**
 * 本文件负责 artifact feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createArtifactRoutes } from './routes.js';
import type { ArtifactStore } from './store.js';

export {
  ArtifactStore,
  type ArtifactGcReport,
  type ArtifactMetadata,
  type ArtifactOwner,
  type ArtifactOwnerKind,
  type ArtifactRef,
} from './store.js';

const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 构造 Artifact 公开入口 模块 中的 `createArtifactFeature` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `store`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 *
 * Returns:
 * - 返回 `createArtifactFeature` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Artifact 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createArtifactFeature(store: ArtifactStore) {
  return {
    put: store.put.bind(store),
    routes: createArtifactRoutes(store),
    initialize: () => collectExpiredArtifacts(store),
    /**
     * 停止 Artifact 公开入口 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
     *
     * Throws:
     * - 当 Artifact 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    async close(): Promise<void> {
      await collectExpiredArtifacts(store);
    },
  };
}

async function collectExpiredArtifacts(store: ArtifactStore): Promise<void> {
  await store.deleteExpiredReferences(
    new Date(Date.now() - ARTIFACT_RETENTION_MS).toISOString(),
  );
}
