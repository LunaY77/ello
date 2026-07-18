import type { AgentMessage, TranscriptStore } from '../../agent/engine/index.js';

import { ThreadLogRepository } from './thread-log.js';

/**
 * Engine 的 transcript port 只读写 thread log 的 `transcript.entry` 记录；它不再
 * 暴露 session tree/leaf API，ThreadRuntime 才是身份和生命周期所有者。
 */
export class ThreadTranscriptStore implements TranscriptStore {
  constructor(private readonly logs: ThreadLogRepository) {}

  async load(threadId: string): Promise<AgentMessage[]> {
    const records = await this.logs.read(threadId);
    return records
      .filter((record) => record.kind === 'transcript.entry')
      .map((record) => record.message as AgentMessage);
  }

  async append(
    threadId: string,
    messages: AgentMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const turnId =
      typeof metadata?.turnId === 'string' ? metadata.turnId : 'turn_unknown';
    for (const message of messages) {
      // transcript 是 JSONL wire data；先按 JSON 语义移除 undefined，其他不可序列化值直接失败。
      const serialized = JSON.stringify(message);
      if (serialized === undefined) {
        throw new Error('Transcript message is not JSON serializable.');
      }
      const normalized = JSON.parse(serialized) as AgentMessage;
      await this.logs.append(threadId, {
        kind: 'transcript.entry',
        turnId,
        role: normalized.role,
        message: normalized,
      });
    }
  }
}
