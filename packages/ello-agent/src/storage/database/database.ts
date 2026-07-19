import Database from 'better-sqlite3';
import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';

import { codingStorageSchema } from './schema.js';

export type CodingStorageSchema = typeof codingStorageSchema;
export type CodingDatabase = BetterSQLite3Database<CodingStorageSchema> & {
  readonly $client: Database.Database;
};

export function createCodingDatabase(
  client: Database.Database,
): CodingDatabase {
  return drizzle(client, { schema: codingStorageSchema });
}

export function configureCodingDatabase(client: Database.Database): void {
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
}

export function transaction<T>(
  db: CodingDatabase,
  fn: (tx: CodingDatabase) => T,
): T {
  return db.$client.transaction(() => fn(db))();
}

export function immediateTransaction<T>(
  db: CodingDatabase,
  fn: (tx: CodingDatabase) => T,
): T {
  return db.$client.transaction(() => fn(db)).immediate();
}
