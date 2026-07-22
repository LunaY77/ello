/**
 * 本文件验证 stores 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import {
  createCheckpointRecordStore,
  type CheckpointRecordStore,
} from '../../src/features/agent/change/store.js';
import { ArtifactStore } from '../../src/features/artifact/store.js';
import {
  createTaskBoardStore,
  type TaskBoardStore,
} from '../../src/features/task/store.js';
import {
  createThreadCatalog,
  type ThreadCatalogProjection,
} from '../../src/features/thread/catalog-store.js';
import {
  createRepositoryStore,
  type RepositoryStore,
} from '../../src/features/workspace/repository-store.js';
import {
  createWorkspaceRecordStore,
  type WorkspaceRecordStore,
} from '../../src/features/workspace/store.js';
import {
  openDatabase,
  type CodingDatabase,
} from '../../src/infra/database/index.js';
import { artifactsDir, stateDatabasePath } from '../../src/infra/paths.js';
import {
  createUsageStore,
  type UsageStore,
} from '../../src/infra/telemetry/usage-store.js';

export interface TestStores {
  readonly db: CodingDatabase;
  readonly artifacts: ArtifactStore;
  readonly taskBoards: TaskBoardStore;
  readonly threads: ThreadCatalogProjection;
  readonly checkpoints: CheckpointRecordStore;
  readonly repositories: RepositoryStore;
  readonly workspaces: WorkspaceRecordStore;
  readonly usage: UsageStore;
  /**
   * 停止 测试夹具的 `stores` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 测试夹具的 `stores` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(): void;
}

/**
 * 测试夹具集中创建完整 store 集；生产装配必须在 app.ts 显式展开。
 *
 * Args:
 * - `options`: 仅作用于 `createTestStores` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - 返回 `createTestStores` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 测试夹具的 `stores` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createTestStores(
  options: {
    readonly databasePath?: string;
    readonly artifactsDir?: string;
  } = {},
): TestStores {
  const database = openDatabase({
    databasePath: options.databasePath ?? stateDatabasePath(),
  });
  const artifacts = new ArtifactStore(
    database.db,
    options.artifactsDir ?? artifactsDir(),
  );
  return {
    db: database.db,
    artifacts,
    taskBoards: createTaskBoardStore(database.db),
    threads: createThreadCatalog(database.db),
    checkpoints: createCheckpointRecordStore(database.db, artifacts),
    repositories: createRepositoryStore(database.db),
    workspaces: createWorkspaceRecordStore(database.db),
    usage: createUsageStore(database.db),
    close: database.close,
  };
}
