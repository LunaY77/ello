export {
  JsonlSessionRepository as JsonlSessionStorage,
  JsonlSessionRepository,
  SESSION_FILE_VERSION,
  type ActiveSessionPath,
  type JsonlSessionSummary,
  type SessionTreeNode,
  type SessionTreeView,
  type SessionRecord,
} from './session/repository.js';
import { JsonlSessionRepository, type JsonlSessionSummary } from './session/repository.js';

/** 兼容旧导出名称的 session list helper。 */
export async function listJsonlSessions(options: { readonly sessionDir: string; readonly cwd: string }): Promise<JsonlSessionSummary[]> {
  return new JsonlSessionRepository(options).list();
}
