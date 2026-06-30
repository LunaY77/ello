import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';

/**
 * 启动期迁移执行器。
 *
 * 这里只负责读取并执行 `bootstrap.sql`，不维护版本表，也不做复杂的迁移编排。
 * 这样二进制分发时不依赖 drizzle-kit，用户首次启动即可完成建库。
 */
export function runCodingStorageMigrations(client: Database.Database): void {
  const sql = readBootstrapSql();
  client.exec(sql);
}

function readBootstrapSql(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.join(here, 'migrations', 'bootstrap.sql'), 'utf8');
}
