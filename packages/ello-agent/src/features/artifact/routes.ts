/**
 * 本文件负责 artifact feature 的typed route 适配。
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

import type { ArtifactStore } from './store.js';

interface ArtifactContext {
  readonly store: ArtifactStore;
}

/** artifact/read 严格按字节分页，offset 越界直接作为参数错误暴露。 */
const artifactHandlers = {
  'artifact/read': async (context, params) => {
    const metadata = context.store.metadata(params.artifactId);
    if (params.offset > metadata.byteSize) {
      throw invalidParams(
        `Artifact offset ${params.offset} exceeds byte size ${metadata.byteSize}.`,
      );
    }
    const content = await context.store.read(params.artifactId);
    const chunk = content.subarray(
      params.offset,
      Math.min(metadata.byteSize, params.offset + params.maxBytes),
    );
    return {
      artifactId: metadata.id,
      contentType: metadata.contentType,
      content: chunk.toString('base64'),
      encoding: 'base64',
      byteCount: metadata.byteSize,
      offset: params.offset,
      readByteCount: chunk.byteLength,
      eof: params.offset + chunk.byteLength >= metadata.byteSize,
    };
  },
} satisfies FeatureHandlerMap<ArtifactContext, 'artifact/read'>;

/**
 * 构造 Artifact route 适配 模块 中的 `createArtifactRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `store`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 *
 * Returns:
 * - 返回 `createArtifactRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Artifact route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createArtifactRoutes(
  store: ArtifactStore,
): RpcRouteFragment<'artifact/read'> {
  return {
    'artifact/read': bindFeatureRoute(
      artifactHandlers,
      () => ({ store }),
      'artifact/read',
    ),
  };
}
