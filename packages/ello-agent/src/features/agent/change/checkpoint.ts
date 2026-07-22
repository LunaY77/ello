/**
 * 本文件负责 agent feature 的“checkpoint”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { errnoCode } from '../../../infra/filesystem.js';

import { CheckpointRecordStore } from './store.js';

/**
 * 代码改动与检查点。
 *
 * 这是 coding-agent **真正独有**的层（`@ello/agent` 不管磁盘改动审计）：
 * 把写类工具（write/edit）产生的文件改动收集成可审计、可回滚的检查点，
 * 支持 `/undo`、查看本会话改了哪些文件、回到某个检查点。
 *
 * 与会话状态解耦：会话 JSONL 记“说了什么/调了什么”，检查点记“磁盘被改成什么样”，
 * 回滚只动磁盘、不改会话历史。
 */

/** 单个文件的一次改动（before/after 用于回滚）。 */
export interface FileChange {
  /** 改动的文件路径（相对工作区或绝对）。 */
  readonly path: string;
  /** 改动前内容；null 表示这是新建文件。 */
  readonly before: string | null;
  /** 改动后内容；null 表示这是删除文件。 */
  readonly after: string | null;
  /** 触发改动的工具调用 id。 */
  readonly toolCallId: string;
  /** 展示用 diff（来自工具输出）。 */
  readonly diff: string;
}

/** 一次封存的检查点：一个 run 内累积的全部改动。 */
export interface Checkpoint {
  readonly id: string;
  readonly runId: string;
  readonly createdAt: string;
  /** 可选标签，比如对应的用户 prompt 摘要。 */
  readonly label?: string;
  readonly changes: FileChange[];
}

/**
 * 检查点存储：累积改动 → 封存 → 列出 → 回滚。
 *
 * 改动收集后由 `seal` 封存，元数据写入全局 SQLite，before/after 内容由
 * ArtifactStore 按内容寻址保存；`rollback` 按相反顺序恢复 before 内容。
 */
export class CheckpointStore {
  /** 当前 run 累积、尚未封存的改动。 */
  private pending: FileChange[] = [];
  private readonly repository: CheckpointRecordStore;

  /**
   * 创建 `CheckpointStore`，由该实例独占 产品 Agent `checkpoint` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   */
  constructor(repository: CheckpointRecordStore) {
    this.repository = repository;
  }

  /**
   * 把一次文件改动累积到当前 open checkpoint。
   *
   * Args:
   * - `change`: `record` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 产品 Agent `checkpoint` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  record(change: FileChange): void {
    this.pending.push(change);
  }

  /**
   * 当前是否有未封存的改动。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /**
   * 封存当前累积的改动为一个检查点并落盘。
   *
   * 通常在 `run.completed` 时调用。无改动时返回 null（不产生空检查点）。
   *
   * Args:
   * - `runId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `label`: `seal` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 产品 Agent `checkpoint` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async seal(runId: string, label?: string): Promise<Checkpoint | null> {
    if (this.pending.length === 0) {
      return null;
    }
    const changes = [...this.pending];
    const checkpoint = await this.repository.seal({
      runId,
      ...(label !== undefined ? { label } : {}),
      changes,
    });
    if (checkpoint !== null) {
      this.pending.splice(0, changes.length);
    }
    return checkpoint;
  }

  /**
   * 列出全部已封存检查点，按创建时间升序。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 产品 Agent `checkpoint` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async list(): Promise<Checkpoint[]> {
    return [...(await this.repository.list())];
  }

  /**
   * 回滚一个检查点：把每个改动的 `before` 反向写回磁盘。
   *
   * 注意回滚本身也是文件写入，调用方（Turn 执行器/Server handler）应按策略过审批
   * （回滚到自己刚做的改动风险低，可默认放行，但应可配置）。本方法只负责
   * 反向应用，返回被回滚的改动列表。
   *
   * @param checkpointId 指定检查点；未提供时回滚最近一个。
   *
   * Args:
   * - `checkpointId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   *
   * Returns:
   * - Promise 在 产品 Agent `checkpoint` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  async rollback(checkpointId?: string): Promise<FileChange[]> {
    const all = await this.list();
    const target =
      checkpointId !== undefined
        ? all.find((cp) => cp.id === checkpointId)
        : all[all.length - 1];
    if (target === undefined) {
      throw new Error(
        checkpointId !== undefined
          ? `Unknown checkpoint: ${checkpointId}`
          : 'No checkpoint to roll back.',
      );
    }
    // 反向应用：按记录的相反顺序写回 before。
    try {
      await assertRollbackPreconditions(target.changes);
      for (const change of [...target.changes].reverse()) {
        if (change.before === null) {
          // 原本是新建：回滚 = 删除该文件。目录清理由调用方或后续 GC 决定。
          await rm(change.path, { force: true });
        } else {
          await mkdir(path.dirname(change.path), { recursive: true });
          await writeFile(change.path, change.before, 'utf8');
        }
      }
      await this.repository.markRolledBack(target.id, 'completed');
    } catch (error) {
      await this.repository.markRolledBack(target.id, 'failed', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return target.changes;
  }
}

/**
 * 在产生任何写操作前模拟完整逆序回滚，确保文件仍处于检查点记录的 after 状态。
 * 同一 run 多次修改同一路径时使用虚拟状态推进，不会把合法的变更链误判为漂移。
 */
async function assertRollbackPreconditions(
  changes: readonly FileChange[],
): Promise<void> {
  const virtualState = new Map<string, { readonly content: string | null }>();
  for (const change of [...changes].reverse()) {
    const normalizedPath = path.resolve(change.path);
    const simulated = virtualState.get(normalizedPath);
    const current =
      simulated === undefined
        ? await readCurrentFile(normalizedPath)
        : simulated.content;
    if (current !== change.after) {
      throw new Error(
        `Checkpoint rollback precondition failed because the file drifted: ${normalizedPath}`,
      );
    }
    virtualState.set(normalizedPath, { content: change.before });
  }
}

async function readCurrentFile(filePath: string): Promise<string | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile()) {
      throw new Error(
        `Checkpoint rollback target is not a regular file: ${filePath}`,
      );
    }
    return readFile(filePath, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}
