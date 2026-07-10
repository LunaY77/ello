import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { and, eq, isNull } from 'drizzle-orm';

import { transaction, type CodingDatabase } from './database.js';
import { artifactReferences, artifacts } from './schema.js';

export type ArtifactOwnerKind = 'checkpoint' | 'tool-result' | 'session-export';

export interface ArtifactOwner {
  readonly kind: ArtifactOwnerKind;
  readonly id: string;
  readonly relation: string;
}

export interface ArtifactRef {
  readonly id: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly contentType: string;
}

export interface ArtifactGcReport {
  readonly deleted: number;
  readonly bytesFreed: number;
}

/**
 * artifact 的唯一读写边界。文件名由内容哈希决定，SQLite 保存元数据和所有权引用。
 */
export class ArtifactStore {
  constructor(
    private readonly db: CodingDatabase,
    private readonly rootDir: string,
  ) {}

  async put(input: {
    readonly kind: string;
    readonly content: string | Buffer;
    readonly contentType: string;
    readonly owner: ArtifactOwner;
  }): Promise<ArtifactRef> {
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, 'utf8');
    const sha256 = hash(content);
    const id = sha256;
    const artifactPath = this.pathFor(sha256);
    const existing = this.findMetadataByHash(sha256);
    if (existing !== undefined) {
      assertMetadata(existing, {
        id,
        path: artifactPath,
        byteSize: content.byteLength,
        contentType: input.contentType,
      });
      await this.verify(existing.id);
      this.addReference(existing.id, input.owner);
      return {
        id: existing.id,
        sha256: existing.sha256,
        byteSize: existing.byteSize,
        contentType: requireContentType(existing),
      };
    }
    const createdFile = await this.writeContent(artifactPath, content, sha256);
    const createdAt = new Date().toISOString();
    try {
      transaction(this.db, () => {
        this.db
          .insert(artifacts)
          .values({
            id,
            kind: input.kind,
            path: artifactPath,
            sha256,
            byteSize: content.byteLength,
            contentType: input.contentType,
            createdAt,
          })
          .onConflictDoNothing({ target: artifacts.sha256 })
          .run();
        const row = this.requireMetadataByHash(sha256);
        assertMetadata(row, {
          id,
          path: artifactPath,
          byteSize: content.byteLength,
          contentType: input.contentType,
        });
        this.addReference(row.id, input.owner, createdAt);
      });
    } catch (error) {
      if (createdFile) {
        await rm(artifactPath, { force: true });
      }
      throw error;
    }
    return {
      id,
      sha256,
      byteSize: content.byteLength,
      contentType: input.contentType,
    };
  }

  async read(id: string): Promise<Buffer> {
    const row = this.requireMetadata(id);
    const content = await readFile(row.path);
    if (content.byteLength !== row.byteSize) {
      throw new Error(
        `Artifact ${id} byte size mismatch: expected ${row.byteSize}, received ${content.byteLength}.`,
      );
    }
    const actualHash = hash(content);
    if (actualHash !== row.sha256) {
      throw new Error(
        `Artifact ${id} sha256 mismatch: expected ${row.sha256}, received ${actualHash}.`,
      );
    }
    return content;
  }

  async verify(id: string): Promise<void> {
    await this.read(id);
  }

  async releaseOwner(owner: ArtifactOwner): Promise<ArtifactGcReport> {
    this.db
      .delete(artifactReferences)
      .where(
        and(
          eq(artifactReferences.ownerKind, owner.kind),
          eq(artifactReferences.ownerId, owner.id),
          eq(artifactReferences.relation, owner.relation),
        ),
      )
      .run();
    return this.deleteUnreferenced();
  }

  async releaseOwnerAll(
    owner: Pick<ArtifactOwner, 'kind' | 'id'>,
  ): Promise<ArtifactGcReport> {
    this.db
      .delete(artifactReferences)
      .where(
        and(
          eq(artifactReferences.ownerKind, owner.kind),
          eq(artifactReferences.ownerId, owner.id),
        ),
      )
      .run();
    return this.deleteUnreferenced();
  }

  async deleteUnreferenced(): Promise<ArtifactGcReport> {
    const rows = this.db
      .select({
        id: artifacts.id,
        path: artifacts.path,
        byteSize: artifacts.byteSize,
      })
      .from(artifacts)
      .leftJoin(
        artifactReferences,
        eq(artifactReferences.artifactId, artifacts.id),
      )
      .where(isNull(artifactReferences.artifactId))
      .all();
    let bytesFreed = 0;
    for (const row of rows) {
      this.db.delete(artifacts).where(eq(artifacts.id, row.id)).run();
      await rm(row.path, { force: true });
      bytesFreed += row.byteSize;
    }
    return { deleted: rows.length, bytesFreed };
  }

  private async writeContent(
    artifactPath: string,
    content: Buffer,
    sha256: string,
  ): Promise<boolean> {
    try {
      const existing = await readFile(artifactPath);
      if (
        existing.byteLength !== content.byteLength ||
        hash(existing) !== sha256
      ) {
        throw new Error(`Artifact content collision at ${artifactPath}.`);
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await mkdir(path.dirname(artifactPath), { recursive: true });
    const temporaryPath = `${artifactPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, { flag: 'wx' });
      await rename(temporaryPath, artifactPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return true;
  }

  private pathFor(sha256: string): string {
    return path.join(this.rootDir, sha256.slice(0, 2), sha256);
  }

  private requireMetadata(id: string): typeof artifacts.$inferSelect {
    const row = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .get();
    if (row === undefined) {
      throw new Error(`Unknown artifact: ${id}`);
    }
    return row;
  }

  private requireMetadataByHash(sha256: string): typeof artifacts.$inferSelect {
    const row = this.findMetadataByHash(sha256);
    if (row === undefined) {
      throw new Error(`Artifact metadata was not written for ${sha256}.`);
    }
    return row;
  }

  private findMetadataByHash(
    sha256: string,
  ): typeof artifacts.$inferSelect | undefined {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.sha256, sha256))
      .get();
  }

  private addReference(
    artifactId: string,
    owner: ArtifactOwner,
    createdAt: string = new Date().toISOString(),
  ): void {
    this.db
      .insert(artifactReferences)
      .values({
        artifactId,
        ownerKind: owner.kind,
        ownerId: owner.id,
        relation: owner.relation,
        createdAt,
      })
      .onConflictDoNothing()
      .run();
  }
}

function assertMetadata(
  row: typeof artifacts.$inferSelect,
  expected: {
    readonly id: string;
    readonly path: string;
    readonly byteSize: number;
    readonly contentType: string;
  },
): void {
  if (
    row.id !== expected.id ||
    row.path !== expected.path ||
    row.byteSize !== expected.byteSize ||
    row.contentType !== expected.contentType
  ) {
    throw new Error(
      `Artifact metadata conflicts with content hash ${row.sha256}.`,
    );
  }
}

function requireContentType(row: typeof artifacts.$inferSelect): string {
  if (row.contentType === null) {
    throw new Error(`Artifact ${row.id} is missing content type metadata.`);
  }
  return row.contentType;
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
