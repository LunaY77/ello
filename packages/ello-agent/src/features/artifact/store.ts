/**
 * 本文件负责 artifact feature 的持久化操作与一致性。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { and, eq, inArray, isNull, lt } from 'drizzle-orm';

import {
  transaction,
  type CodingDatabase,
} from '../../infra/database/database.js';
import { artifactReferences, artifacts } from '../../infra/database/schema.js';
import { errnoCode } from '../../infra/filesystem.js';

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

export interface ArtifactMetadata extends ArtifactRef {
  readonly kind: string;
  readonly createdAt: string;
}

/**
 * artifact 的唯一读写边界。文件名由内容哈希决定，SQLite 保存元数据和所有权引用。
 */
export class ArtifactStore {
  /**
   * 创建 `ArtifactStore`，由该实例独占 Artifact 持久化 store 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `db`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   * - `rootDir`: `constructor ArtifactStore` 所需的业务值；函数按声明读取，不补造缺失内容。
   */
  constructor(
    private readonly db: CodingDatabase,
    private readonly rootDir: string,
  ) {}

  /**
   * 执行 Artifact 持久化 store 模块 定义的 `put` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `input`: `put` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 Artifact 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 读取 Artifact 持久化 store 模块 的 `read` 视图，不转移底层状态所有权。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - Promise 在 Artifact 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Artifact 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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

  /**
   * 执行 Artifact 持久化 store 模块 定义的 `metadata` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - 返回 `metadata` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  metadata(id: string): ArtifactMetadata {
    const row = this.requireMetadata(id);
    return {
      id: row.id,
      kind: row.kind,
      sha256: row.sha256,
      byteSize: row.byteSize,
      contentType: requireContentType(row),
      createdAt: row.createdAt,
    };
  }

  /**
   * 执行 Artifact 持久化 store 模块 定义的 `verify` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `id`: 当前领域对象的稳定键；不得用空值或临时默认值代替。
   *
   * Returns:
   * - Promise 在 Artifact 持久化 store 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async verify(id: string): Promise<void> {
    await this.read(id);
  }

  /**
   * 执行 Artifact 持久化 store 模块 定义的 `releaseOwner` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `owner`: `releaseOwner` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Artifact 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 执行 Artifact 持久化 store 模块 定义的 `releaseOwnerAll` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `owner`: `releaseOwnerAll` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Artifact 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
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

  /**
   * 按 Artifact 持久化 store 模块 的一致性约束执行 `deleteUnreferenced` 状态变更。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Artifact 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Artifact 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
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

  /**
   * checkpoint 永久保留；仅清理超过保留期的临时输出和导出引用。
   *
   * Args:
   * - `createdBefore`: `deleteExpiredReferences` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Artifact 持久化 store 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Artifact 持久化 store 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async deleteExpiredReferences(
    createdBefore: string,
  ): Promise<ArtifactGcReport> {
    this.db
      .delete(artifactReferences)
      .where(
        and(
          inArray(artifactReferences.ownerKind, [
            'tool-result',
            'session-export',
          ]),
          lt(artifactReferences.createdAt, createdBefore),
        ),
      )
      .run();
    return this.deleteUnreferenced();
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
      if (errnoCode(error) !== 'ENOENT') {
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
      .onConflictDoUpdate({
        target: [
          artifactReferences.artifactId,
          artifactReferences.ownerKind,
          artifactReferences.ownerId,
          artifactReferences.relation,
        ],
        set: { createdAt },
      })
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
