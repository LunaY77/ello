/**
 * 本文件验证 features 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { createAgentRoutes } from '../../src/features/agent/routes.js';
import { createArtifactFeature } from '../../src/features/artifact/index.js';
import { createConfigFeature } from '../../src/features/config/index.js';
import { createFsFeature } from '../../src/features/fs/index.js';
import { createMemoryFeature } from '../../src/features/memory/index.js';
import { createModelFeature } from '../../src/features/model/index.js';
import { createSkillFeature } from '../../src/features/skill/index.js';
import { createTaskFeature } from '../../src/features/task/index.js';
import { createExportRoutes } from '../../src/features/thread/export.js';
import type {
  ThreadFeature,
  ThreadStore,
} from '../../src/features/thread/index.js';
import { createThreadRoutes } from '../../src/features/thread/routes.js';
import { createToolFeature } from '../../src/features/tool/index.js';
import { createWorkspaceFeature } from '../../src/features/workspace/index.js';
import type { TestStores } from '../support/stores.js';

/**
 * 构造 测试夹具的 `features` 模块 中的 `createTestFeatures` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `input`: `createTestFeatures` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `createTestFeatures` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 测试夹具的 `features` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createTestFeatures(input: {
  readonly storage: TestStores;
  readonly threads: ThreadFeature;
  readonly store: ThreadStore;
  readonly compact: (threadId: string) => Promise<unknown | null>;
}) {
  const artifacts = createArtifactFeature(input.storage.artifacts);
  const fs = createFsFeature(input.storage.artifacts);
  const routes = {
    ...createConfigFeature().routes,
    ...createModelFeature().routes,
    ...createAgentRoutes(),
    ...createToolFeature(input.storage.taskBoards).routes,
    ...createSkillFeature().routes,
    ...createMemoryFeature().routes,
    ...createTaskFeature(input.storage.taskBoards).routes,
    ...artifacts.routes,
    ...fs.routes,
    ...createWorkspaceFeature({
      repositories: input.storage.repositories,
      workspaces: input.storage.workspaces,
    }).routes,
    ...createThreadRoutes({
      artifacts: input.storage.artifacts,
      compact: input.compact,
      threads: input.threads,
    }),
    ...createExportRoutes({
      artifacts: input.storage.artifacts,
      store: input.store,
      threads: input.threads,
    }),
  };
  return {
    routes,
    initialize: () => artifacts.initialize(),
    releaseConnection: (connectionId: string) =>
      fs.releaseConnection(connectionId),
    /**
     * 停止 测试夹具的 `features` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
     *
     * Throws:
     * - 当 测试夹具的 `features` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    async close(): Promise<void> {
      await fs.close();
      await artifacts.close();
    },
  };
}
