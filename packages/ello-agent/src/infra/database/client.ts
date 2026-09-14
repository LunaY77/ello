/**
 * 本文件负责基础设施层的 SQLite 客户端工厂职责。
 *
 * Node 运行时使用 better-sqlite3;`bun build --compile` 打包的 sidecar 运行在
 * Bun(JavaScriptCore)中,better-sqlite3 的 V8 ABI 原生绑定无法被 Bun 加载,
 * 此时改用 Bun 内置的 bun:sqlite,并包装出调用方依赖的 better-sqlite3 最小接口。
 */
import { createRequire } from 'node:module';

import Database from 'better-sqlite3';

/** bun:sqlite 语句对象的最小结构(只声明适配层用到的方法)。 */
interface BunStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  values(...params: unknown[]): unknown[][];
}

/** bun:sqlite Database 的最小结构(只声明适配层用到的方法)。 */
interface BunSqliteDatabase {
  prepare(sql: string): BunStatement;
  exec(sql: string): void;
  transaction(fn: (...args: unknown[]) => unknown): {
    (...args: unknown[]): unknown;
    deferred(...args: unknown[]): unknown;
    immediate(...args: unknown[]): unknown;
    exclusive(...args: unknown[]): unknown;
  };
  close(): void;
}

/**
 * 懒加载 bun:sqlite,避免静态导入导致 Node 运行时在模块解析阶段失败;
 * 同时让 bun build 把该调用保留为运行期内置模块解析,而非打包期产物。
 */
function loadBunSqliteDatabase(): new (path: string) => BunSqliteDatabase {
  const require = createRequire(import.meta.url);
  return (
    require('bun:sqlite') as {
      Database: new (path: string) => BunSqliteDatabase;
    }
  ).Database;
}

/**
 * 把 bun:sqlite Database 包装为调用方使用的 better-sqlite3 最小接口。
 *
 * 语义差异在此对齐:空结果 get 由 null 归一为 undefined;drizzle 依赖的
 * raw() 行数组模式用 values() 模拟;bun:sqlite 没有 pragma(),改用 exec 执行。
 */
function adaptBunSqliteDatabase(db: BunSqliteDatabase): Database.Database {
  const wrapStatement = (stmt: BunStatement) => ({
    run: (...params: unknown[]) => stmt.run(...params),
    get: (...params: unknown[]) => stmt.get(...params) ?? undefined,
    all: (...params: unknown[]) => stmt.all(...params),
    raw: () => ({
      get: (...params: unknown[]) => stmt.values(...params)[0] ?? undefined,
      all: (...params: unknown[]) => stmt.values(...params),
    }),
  });
  const transaction = (fn: (...args: unknown[]) => unknown) =>
    db.transaction(fn);
  return {
    prepare: (sql: string) => wrapStatement(db.prepare(sql)),
    pragma: (source: string) => {
      db.exec(`PRAGMA ${source};`);
    },
    transaction,
    close: () => db.close(),
  } as unknown as Database.Database;
}

/**
 * 打开 SQLite 客户端:Node 下返回 better-sqlite3 实例;Bun 运行时(bun
 * --compile sidecar)返回 bun:sqlite 的兼容适配实例。
 */
export function openSqliteClient(databasePath: string): Database.Database {
  if ('bun' in process.versions) {
    const BunDatabase = loadBunSqliteDatabase();
    return adaptBunSqliteDatabase(new BunDatabase(databasePath));
  }
  return new Database(databasePath);
}
