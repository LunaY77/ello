/**
 * 本文件负责基础设施层的公开入口与 factory。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { stateDatabasePath } from '../../infra/paths.js';

import {
  configureCodingDatabase,
  createCodingDatabase,
  type CodingDatabase,
} from './database.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

interface MigrationDescriptor {
  readonly hash: string;
  readonly createdAt: number;
  readonly tag: string;
}

export interface DatabaseHandle {
  readonly db: CodingDatabase;
  /**
   * 停止 基础设施层的 `index` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 基础设施层的 `index` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(): void;
}

/**
 * 打开进程级 SQLite 连接并完成迁移。
 *
 * 这里只拥有数据库连接生命周期，不创建任何 feature store，避免数据库层重新变成全局服务容器。
 *
 * Args:
 * - `options`: 仅作用于 `openDatabase` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - 返回 `openDatabase` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 基础设施层的 `index` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function openDatabase(
  options: {
    readonly databasePath?: string;
  } = {},
): DatabaseHandle {
  const databasePath = options.databasePath ?? stateDatabasePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const client = new Database(databasePath);
  try {
    configureCodingDatabase(client);
    const db = createCodingDatabase(client);
    const migrations = readMigrationDescriptors();
    validateAppliedMigrations(client, migrations);
    migrate(db, { migrationsFolder });
    validateAppliedMigrations(client, migrations);
    let closed = false;
    return {
      db,
      /**
       * 停止 基础设施层的 `index` 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
       *
       * Args:
       * - 无：操作使用实例或闭包已经持有的稳定状态。
       *
       * Returns:
       * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
       *
       * Throws:
       * - 当 基础设施层的 `index` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
       */
      close(): void {
        if (closed) return;
        closed = true;
        client.close();
      },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * Drizzle 只按时间戳寻找下一条迁移，不复核已执行 SQL；启动前后校验完整前缀，防止历史漂移。
 */
function validateAppliedMigrations(
  client: Database.Database,
  expected: ReadonlyArray<MigrationDescriptor>,
): void {
  const table = client
    .prepare(
      "select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (table === undefined) return;
  const applied = client
    .prepare<
      [],
      { readonly hash: string; readonly createdAt: number }
    >('select hash, created_at as createdAt from __drizzle_migrations order by created_at, id')
    .all();
  if (applied.length > expected.length) {
    throw new Error(
      `Database migration version is newer than this Server (${applied.length} > ${expected.length}).`,
    );
  }
  for (const [index, actual] of applied.entries()) {
    const migration = expected[index];
    if (migration === undefined || actual.createdAt !== migration.createdAt) {
      throw new Error(
        `Database migration history diverges at position ${index + 1}; refusing to continue.`,
      );
    }
    if (actual.hash !== migration.hash) {
      throw new Error(
        `Database migration checksum mismatch for ${migration.tag}; refusing to continue.`,
      );
    }
  }
}

function readMigrationDescriptors(): ReadonlyArray<MigrationDescriptor> {
  const journal: unknown = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  );
  if (
    typeof journal !== 'object' ||
    journal === null ||
    !('entries' in journal) ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error('Migration journal has no entries.');
  }
  return journal.entries.map((entry: unknown, index: number) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('when' in entry) ||
      typeof entry.when !== 'number' ||
      !Number.isSafeInteger(entry.when) ||
      !('tag' in entry) ||
      typeof entry.tag !== 'string' ||
      entry.tag === ''
    ) {
      throw new Error(`Migration journal entry ${index + 1} is invalid.`);
    }
    const sql = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`));
    return {
      tag: entry.tag,
      createdAt: entry.when,
      hash: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

export type { CodingDatabase } from './database.js';
export { immediateTransaction, transaction } from './database.js';
