import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';

import { runCodingStorageMigrations } from './migrations.js';
import { globalStateDatabasePath } from './paths.js';
import { codingStorageSchema } from './schema.js';

export type CodingStorageSchema = typeof codingStorageSchema;
export type CodingDatabase = BetterSQLite3Database<CodingStorageSchema> & {
  readonly $client: Database.Database;
};

/**
 * 打开全局 coding-agent SQLite。
 *
 * 这个函数是产品层唯一的开库入口：调用方不能传 cwd，也不能传项目路径。测试需要
 * 隔离时通过 `ELLO_HOME` 改变 `globalHomeDir()`，仍然只会得到一个全局库。
 */
export async function openGlobalCodingDatabase(): Promise<CodingDatabase> {
  const file = globalStateDatabasePath();
  await mkdir(path.dirname(file), { recursive: true });
  const client = new Database(file);
  configureClient(client);
  runCodingStorageMigrations(client);
  return drizzle(client, { schema: codingStorageSchema });
}

/**
 * 同步打开全局库。
 *
 * 少数构造函数需要同步完成依赖装配（例如现有 CheckpointStore 的 API），因此保留
 * 同步入口；它仍然使用同一套 PRAGMA 和迁移逻辑。
 */
export function openGlobalCodingDatabaseSync(): CodingDatabase {
  const file = globalStateDatabasePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const client = new Database(file);
  configureClient(client);
  runCodingStorageMigrations(client);
  return drizzle(client, { schema: codingStorageSchema });
}

/** 关闭数据库；repository/service 测试可显式释放句柄。 */
export function closeCodingDatabase(db: CodingDatabase): void {
  db.$client.close();
}

/** 执行 SQLite 事务，保持 repository 对外 async、内部同步提交。 */
export function transaction<T>(
  db: CodingDatabase,
  fn: (tx: CodingDatabase) => T,
): T {
  const run = db.$client.transaction(() => fn(db));
  return run();
}

/** PRAGMA 是每次开连接的运行时约束，不依赖迁移表。 */
function configureClient(client: Database.Database): void {
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
}
