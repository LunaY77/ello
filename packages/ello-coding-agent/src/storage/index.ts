export {
  closeCodingDatabase,
  openGlobalCodingDatabase,
  openGlobalCodingDatabaseSync,
  transaction,
  type CodingDatabase,
} from './database.js';
export { globalArtifactsDir, globalStateDatabasePath } from './paths.js';
export * as storageSchema from './schema.js';
