import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CheckpointRepository } from '../storage/repositories/checkpoint-repository.js';

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
  private readonly repository: CheckpointRepository;

  constructor(repository: CheckpointRepository) {
    this.repository = repository;
  }

  /** 把一次文件改动累积到当前 open checkpoint。 */
  record(change: FileChange): void {
    this.pending.push(change);
  }

  /** 当前是否有未封存的改动。 */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /**
   * 封存当前累积的改动为一个检查点并落盘。
   *
   * 通常在 `run.completed` 时调用。无改动时返回 null（不产生空检查点）。
   */
  async seal(runId: string, label?: string): Promise<Checkpoint | null> {
    if (this.pending.length === 0) {
      return null;
    }
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      runId,
      createdAt: new Date().toISOString(),
      ...(label !== undefined ? { label } : {}),
      changes: this.pending,
    };
    this.pending = [];
    return this.repository.seal({
      runId,
      ...(label !== undefined ? { label } : {}),
      changes: checkpoint.changes,
    });
  }

  /** 列出全部已封存检查点，按创建时间升序。 */
  async list(): Promise<Checkpoint[]> {
    return [...(await this.repository.list())];
  }

  /**
   * 回滚一个检查点：把每个改动的 `before` 反向写回磁盘。
   *
   * 注意回滚本身也是文件写入，调用方（CodingSession/CLI）应按 06 的策略过审批
   * （回滚到自己刚做的改动风险低，可默认放行，但应可配置）。本方法只负责
   * 反向应用，返回被回滚的改动列表。
   *
   * @param checkpointId 指定检查点；缺省回滚最近一个。
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
