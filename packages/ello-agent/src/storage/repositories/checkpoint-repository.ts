import { createHash, randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import type { Checkpoint, FileChange } from '../../agent/change/checkpoint.js';
import type { ArtifactRef, ArtifactStore } from '../artifacts/artifact-store.js';
import { transaction, type CodingDatabase } from '../database/database.js';
import {
  checkpointFileChanges,
  checkpointRollbacks,
  checkpoints,
} from '../database/schema.js';

/**
 * checkpoint 仓储。
 *
 * DB 只存 checkpoint 和文件变化的元数据；before/after 内容交给 ArtifactStore。
 * 这样 rollback/list/detail 可以结构化查询，同时避免把代码快照直接塞进 SQLite。
 */
export class CheckpointRepository {
  constructor(
    private readonly db: CodingDatabase,
    private readonly artifacts: ArtifactStore,
  ) {}

  async seal(input: {
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
          before: await this.putArtifact(
            checkpoint.id,
            `change:${index}:before`,
            change.before,
          ),
          after: await this.putArtifact(
            checkpoint.id,
            `change:${index}:after`,
            change.after,
          ),
        });
      }

      transaction(this.db, () => {
        this.db
          .insert(checkpoints)
          .values({
            id: checkpoint.id,
            runId: input.runId,
            label: input.label ?? null,
            status: 'active',
            createdAt: now,
            rolledBackAt: null,
          })
          .run();

        for (let index = 0; index < input.changes.length; index += 1) {
          const change = input.changes[index]!;
          const artifactRow = artifactRows[index]!;
          this.db
            .insert(checkpointFileChanges)
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
      await this.artifacts.releaseOwnerAll({
        kind: 'checkpoint',
        id: checkpoint.id,
      });
      throw error;
    }
    return checkpoint;
  }

  async list(): Promise<readonly Checkpoint[]> {
    const rows = this.db
      .select()
      .from(checkpoints)
      .orderBy(asc(checkpoints.createdAt))
      .all();
    return Promise.all(rows.map((row) => this.detail(row.id))).then((items) =>
      items.filter((item): item is Checkpoint => item !== null),
    );
  }

  async detail(id: string): Promise<Checkpoint | null> {
    const checkpoint = this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, id))
      .get();
    if (checkpoint === undefined) {
      return null;
    }
    const rows = this.db
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
            : (await this.artifacts.read(row.beforeArtifactId)).toString(
                'utf8',
              ),
        after:
          row.afterArtifactId === null
            ? null
            : (await this.artifacts.read(row.afterArtifactId)).toString('utf8'),
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

  async markRolledBack(
    checkpointId: string,
    status: 'completed' | 'failed',
    input: {
      readonly runId?: string | undefined;
      readonly errorMessage?: string | undefined;
    } = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    transaction(this.db, () => {
      this.db
        .insert(checkpointRollbacks)
        .values({
          id: randomUUID(),
          checkpointId,
          runId: input.runId ?? null,
          status,
          errorMessage: input.errorMessage ?? null,
          createdAt: now,
        })
        .run();
      if (status === 'completed') {
        this.db
          .update(checkpoints)
          .set({ status: 'rolled_back', rolledBackAt: now })
          .where(eq(checkpoints.id, checkpointId))
          .run();
      }
    });
  }

  private async putArtifact(
    checkpointId: string,
    relation: string,
    content: string | null,
  ): Promise<ArtifactRef | null> {
    if (content === null) {
      return null;
    }
    return this.artifacts.put({
      kind: 'checkpoint',
      content,
      contentType: 'text/plain; charset=utf-8',
      owner: { kind: 'checkpoint', id: checkpointId, relation },
    });
  }
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
