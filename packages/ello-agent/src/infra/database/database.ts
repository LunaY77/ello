/**
 * 本文件负责基础设施层的“database”模块职责。
 *
 * 外部进程、数据库、文件或遥测资源由显式参数和返回值限定所有权，不保存产品会话状态。
 * 适配边界只转换已声明的协议；资源错误保持原因并向调用方传播。
 */
import Database from 'better-sqlite3';
import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';

import { codingStorageSchema } from './schema.js';

export type DatabaseSchema = typeof codingStorageSchema;
export type CodingDatabase = BetterSQLite3Database<DatabaseSchema> & {
  readonly $client: Database.Database;
};

/**
 * 构造 基础设施层的 `database` 模块 中的 `createCodingDatabase` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `client`: `createCodingDatabase` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createCodingDatabase` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 基础设施层的 `database` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createCodingDatabase(
  client: Database.Database,
): CodingDatabase {
  return drizzle(client, { schema: codingStorageSchema });
}

/**
 * 执行 基础设施层的 `database` 模块 定义的 `configureCodingDatabase` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `client`: `configureCodingDatabase` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 基础设施层的 `database` 模块 的同步状态变更完成后返回，不产生业务结果。
 */
export function configureCodingDatabase(client: Database.Database): void {
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
}

/**
 * 执行 基础设施层的 `database` 模块 定义的 `transaction` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `db`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 * - `fn`: `transaction` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `transaction` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function transaction<T>(
  db: CodingDatabase,
  fn: (tx: CodingDatabase) => T,
): T {
  return db.$client.transaction(() => fn(db))();
}

/**
 * 执行 基础设施层的 `database` 模块 定义的 `immediateTransaction` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `db`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
 * - `fn`: `immediateTransaction` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `immediateTransaction` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function immediateTransaction<T>(
  db: CodingDatabase,
  fn: (tx: CodingDatabase) => T,
): T {
  return db.$client.transaction(() => fn(db)).immediate();
}
