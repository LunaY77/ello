import type { CodingAgentConfig } from '../config.js';
import {
  listJsonlSessions,
  type JsonlSessionSummary,
} from '../jsonl-session-storage.js';

/**
 * 列出配置会话目录中的所有持久化 coding-agent 会话。
 */
export async function listCodingAgentSessions(
  config: CodingAgentConfig,
): Promise<JsonlSessionSummary[]> {
  return listJsonlSessions(config.sessionDir);
}
