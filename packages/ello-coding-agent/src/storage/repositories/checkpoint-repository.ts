import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { asc, eq } from 'drizzle-orm';

import type { Checkpoint, FileChange } from '../../change/checkpoint.js';
import {
  openGlobalCodingDatabaseSync,
  transaction,
  type CodingDatabase,
} from '../database.js';
import { globalArtifactsDir } from '../paths.js';
import {
  artifacts,
  checkpointFileChanges,
  checkpointRollbacks,
  checkpoints,
} from '../schema.js';

/**
 * checkpoint 仓储。
 *
 * DB 只存 checkpoint 和文件变化的元数据；before/after 内容写入全局 artifacts。
 * 这样 rollback/list/detail 可以结构化查询，同时避免把代码快照直接塞进 SQLite。
 */
export class CheckpointRepository {
  constructor(private readonly db: CodingDatabase = openGlobalCodingDatabaseSync()) {}

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
    const artifactRows = await Promise.all(
      input.changes.flatMap((change) => [
        writeArtifact('checkpoint_before', change.before),
        writeArtifact('checkpoint_after', change.after),
      ]),
    );

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
        const before = artifactRows[index * 2]!;
        const after = artifactRows[index * 2 + 1]!;
        for (const artifact of [before, after]) {
          if (artifact !== null) {
            this.db.insert(artifacts).values(artifact).run();
          }
        }
        this.db
          .insert(checkpointFileChanges)
          .values({
            id: randomUUID(),
            checkpointId: checkpoint.id,
            path: change.path,
            pathHash: sha256(change.path),
            changeType: changeType(change),
            beforeArtifactId: before?.id ?? null,
            afterArtifactId: after?.id ?? null,
            beforeSha256: before?.sha256 ?? null,
            afterSha256: after?.sha256 ?? null,
            diff: change.diff,
            toolCallId: change.toolCallId,
            createdAt: now,
          })
          .run();
      }
    });
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
            : await this.readArtifact(row.beforeArtifactId),
        after:
          row.afterArtifactId === null
            ? null
            : await this.readArtifact(row.afterArtifactId),
        toolCallId: row.toolCallId ?? '',
        diff: row.diff ?? '',
      })),
    );
    return {
      id: checkpoint.id,
      runId: checkpoint.runId ?? '',
      createdAt: checkpoint.createdAt,
      ...(checkpoint.label !== null ? { label: checkpoint.label } : {}),
      changes,
    };
  }

  async markRolledBack(
    checkpointId: string,
    status: 'completed' | 'failed',
    input: { readonly runId?: string | undefined; readonly errorMessage?: string | undefined } = {},
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

  private async readArtifact(id: string): Promise<string | null> {
    const row = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .get();
    if (row === undefined) {
      return null;
    }
    return readFile(row.path, 'utf8');
  }
}

async function writeArtifact(
  kind: string,
  content: string | null,
): Promise<typeof artifacts.$inferInsert | null> {
  if (content === null) {
    return null;
  }
  const hash = sha256(content);
  const id = randomUUID();
  const dir = path.join(globalArtifactsDir(), kind, hash.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.txt`);
  await writeFile(filePath, content, 'utf8');
  return {
    id,
    kind,
    path: filePath,
    sha256: hash,
    byteSize: Buffer.byteLength(content, 'utf8'),
    contentType: 'text/plain; charset=utf-8',
    createdAt: new Date().toISOString(),
  };
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
