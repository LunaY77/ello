/**
 * 本文件负责 agent feature 的持久化操作与一致性。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash, randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import {
  transaction,
  type CodingDatabase,
} from '../../../infra/database/database.js';
import {
  checkpointFileChanges,
  checkpointRollbacks,
  checkpoints,
} from '../../../infra/database/schema.js';
import type { ArtifactRef, ArtifactStore } from '../../artifact/index.js';

import type { Checkpoint, FileChange } from './checkpoint.js';

/** Checkpoint 元数据与 Artifact 内容之间的持久化边界。 */
export interface CheckpointRecordStore {
  /**
   * 按 产品 Agent 持久化 store 模块 的一致性约束执行 `seal` 状态变更。
   *
   * Args:
   * - `input`: `seal` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 产品 Agent 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  seal(input: {
    readonly runId: string;
    readonly label?: string;
    readonly changes: ReadonlyArray<FileChange>;
  }): Promise<Checkpoint | null>;
  /**
   * 读取 产品 Agent 持久化 store 模块 的 `list` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 产品 Agent 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  list(): Promise<ReadonlyArray<Checkpoint>>;
  /**
   * 读取 产品 Agent 持久化 store 模块 的 `detail` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - Promise 在 产品 Agent 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  detail(id: string): Promise<Checkpoint | null>;
  /**
   * 按 产品 Agent 持久化 store 模块 的一致性约束执行 `markRolledBack` 状态变更。
   *
   * Args:
   * - `checkpointId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `status`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   * - `input`: `markRolledBack` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 产品 Agent 持久化 store 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  markRolledBack(
    checkpointId: string,
    status: 'completed' | 'failed',
    input?: {
      readonly runId?: string;
      readonly errorMessage?: string;
    },
  ): Promise<void>;
}

/**
 * 创建 Checkpoint record store。
 *
 * SQLite 只保存结构化元数据，文件内容由 ArtifactStore 按 owner 关系持有。
 *
 * Args:
 * - `db`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 * - `artifacts`: `createCheckpointRecordStore` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createCheckpointRecordStore` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createCheckpointRecordStore(
  db: CodingDatabase,
  artifacts: ArtifactStore,
): CheckpointRecordStore {
  async function seal(input: {
    readonly runId: string;
    readonly label?: string | undefined;
    readonly changes: readonly FileChange[];
  }): Promise<Checkpoint | null> {
    if (input.changes.length === 0) {
      return null;
    }
    const now = new Date().toISOString();
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      runId: input.runId,
      createdAt: now,
      ...(input.label !== undefined ? { label: input.label } : {}),
      changes: [...input.changes],
    };
    const artifactRows: Array<{
      readonly before: ArtifactRef | null;
      readonly after: ArtifactRef | null;
    }> = [];
    try {
      for (const [index, change] of input.changes.entries()) {
        artifactRows.push({
          before: await putArtifact(
            checkpoint.id,
            `change:${index}:before`,
            change.before,
          ),
          after: await putArtifact(
            checkpoint.id,
            `change:${index}:after`,
            change.after,
          ),
        });
      }

      transaction(db, () => {
        db.insert(checkpoints)
          .values({
            id: checkpoint.id,
            runId: input.runId,
            label: input.label ?? null,
            status: 'active',
            createdAt: now,
            rolledBackAt: null,
          })
          .run();

        for (const [index, change] of input.changes.entries()) {
          const artifactRow = artifactRows[index];
          if (artifactRow === undefined) {
            throw new Error(`Checkpoint artifact row ${index} is missing.`);
          }
          db.insert(checkpointFileChanges)
            .values({
              id: randomUUID(),
              checkpointId: checkpoint.id,
              path: change.path,
              pathHash: sha256(change.path),
              changeType: changeType(change),
              beforeArtifactId: artifactRow.before?.id ?? null,
              afterArtifactId: artifactRow.after?.id ?? null,
              beforeSha256: artifactRow.before?.sha256 ?? null,
              afterSha256: artifactRow.after?.sha256 ?? null,
              diff: change.diff,
              toolCallId: change.toolCallId,
              createdAt: now,
            })
            .run();
        }
      });
    } catch (error) {
      try {
        await artifacts.releaseOwnerAll({
          kind: 'checkpoint',
          id: checkpoint.id,
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Checkpoint ${checkpoint.id} failed and artifact cleanup failed.`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
    return checkpoint;
  }

  async function list(): Promise<readonly Checkpoint[]> {
    const rows = db
      .select()
      .from(checkpoints)
      .orderBy(asc(checkpoints.createdAt))
      .all();
    const items = await Promise.all(rows.map((row) => detail(row.id)));
    return items.map((item, index) => {
      if (item === null) {
        const row = rows[index];
        if (row === undefined) {
          throw new Error(`Checkpoint list index ${index} has no source row.`);
        }
        throw new Error(`Checkpoint list referenced missing row ${row.id}.`);
      }
      return item;
    });
  }

  async function detail(id: string): Promise<Checkpoint | null> {
    const checkpoint = db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, id))
      .get();
    if (checkpoint === undefined) {
      return null;
    }
    const rows = db
      .select()
      .from(checkpointFileChanges)
      .where(eq(checkpointFileChanges.checkpointId, id))
      .orderBy(asc(checkpointFileChanges.createdAt))
      .all();
    const changes = await Promise.all(
      rows.map(async (row) => ({
        path: row.path,
        before:
          row.beforeArtifactId === null
            ? null
            : (await artifacts.read(row.beforeArtifactId)).toString('utf8'),
        after:
          row.afterArtifactId === null
            ? null
            : (await artifacts.read(row.afterArtifactId)).toString('utf8'),
        toolCallId: requireColumn(row.id, 'tool_call_id', row.toolCallId),
        diff: requireColumn(row.id, 'diff', row.diff),
      })),
    );
    return {
      id: checkpoint.id,
      runId: requireColumn(checkpoint.id, 'run_id', checkpoint.runId),
      createdAt: checkpoint.createdAt,
      ...(checkpoint.label !== null ? { label: checkpoint.label } : {}),
      changes,
    };
  }

  async function markRolledBack(
    checkpointId: string,
    status: 'completed' | 'failed',
    input?: {
      readonly runId?: string;
      readonly errorMessage?: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    transaction(db, () => {
      db.insert(checkpointRollbacks)
        .values({
          id: randomUUID(),
          checkpointId,
          runId: input === undefined ? null : (input.runId ?? null),
          status,
          errorMessage:
            input === undefined ? null : (input.errorMessage ?? null),
          createdAt: now,
        })
        .run();
      if (status === 'completed') {
        db.update(checkpoints)
          .set({ status: 'rolled_back', rolledBackAt: now })
          .where(eq(checkpoints.id, checkpointId))
          .run();
      }
    });
  }

  async function putArtifact(
    checkpointId: string,
    relation: string,
    content: string | null,
  ): Promise<ArtifactRef | null> {
    if (content === null) {
      return null;
    }
    return artifacts.put({
      kind: 'checkpoint',
      content,
      contentType: 'text/plain; charset=utf-8',
      owner: { kind: 'checkpoint', id: checkpointId, relation },
    });
  }
  return { seal, list, detail, markRolledBack };
}

function requireColumn(
  rowId: string,
  column: string,
  value: string | null,
): string {
  if (value === null) {
    throw new Error(
      `Invalid checkpoints row ${rowId}: column ${column} is null.`,
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function changeType(change: FileChange): string {
  if (change.before === null) {
    return 'create';
  }
  if (change.after === null) {
    return 'delete';
  }
  return 'update';
}
