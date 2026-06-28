import { randomUUID } from 'node:crypto';

import type {
  AgentMessage,
  AgentStreamEvent,
  SessionCompactionReport,
  SessionStore,
} from '@ello/agent';

import { JsonlSessionRepository } from './repository.js';

/**
 * 基于 JSONL 会话树的 `SessionStore` 实现。
 *
 * 这是内核 `createAgent({ session })` 的会话后端。内核在合适时机调用：
 * - `load`：恢复某个会话当前分支的消息序列；
 * - `append`：把本轮新增消息追加到当前 leaf 之下；
 * - `appendEvent`：把事件落盘，供回放（可选）；
 * - `compact` / `replace`：压缩边界落盘（具体算法在压缩器里）。
 *
 * 它与 `JsonlSessionRepository`（fork/checkout/tree/export 等会话树产品能力）
 * 建在**同一份 JSONL** 之上：store 负责内核读写，repository 负责产品操作，
 * 两者通过 `repository` 与共享的 leaf 指针表协作，不再像旧实现那样各拼一套。
 */
export class JsonlSessionStore implements SessionStore {
  /** 底层会话树仓库，store 与 repository 共用同一实例。 */
  readonly repository: JsonlSessionRepository;

  /** 每个会话当前的 active leaf entry id，append 时作为父指针。 */
  private readonly leaves = new Map<string, string | null>();

  constructor(options: { readonly sessionDir: string; readonly cwd: string }) {
    this.repository = new JsonlSessionRepository(options);
  }

  /** 读取会话当前分支的消息序列；顺带刷新 leaf 指针缓存。 */
  async load(sessionId: string): Promise<AgentMessage[]> {
    const opened = await this.repository.open(sessionId);
    this.leaves.set(sessionId, opened.leafEntryId);
    return opened.messages;
  }

  /** 把本轮新增消息追加到 active leaf 之下。 */
  async append(sessionId: string, messages: AgentMessage[]): Promise<void> {
    const parent = await this.leafOf(sessionId);
    const nextLeaf = await this.repository.appendMessages(sessionId, parent, messages);
    this.leaves.set(sessionId, nextLeaf);
  }

  /** 把内核事件追加为 event entry，供回放/审计（可选能力）。 */
  async appendEvent(sessionId: string, event: AgentStreamEvent): Promise<void> {
    const parent = await this.leafOf(sessionId);
    const id = await this.repository.appendEvent(sessionId, parent, event);
    this.leaves.set(sessionId, id);
  }

  /**
   * 压缩边界落盘。
   *
   * 实际的历史改写由压缩器经 `replace` 完成，这里仅在会话树上补一条
   * compaction 记录留痕；摘要正文从 metadata.summary 读，缺省给一句兜底描述。
   */
  async compact(
    sessionId: string,
    report: SessionCompactionReport,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.compact(sessionId, {
      id: randomUUID(),
      ...(await this.boundaryOf(sessionId)),
      summary:
        typeof metadata?.summary === 'string'
          ? metadata.summary
          : `Auto compacted ${report.beforeMessageCount} messages to ${report.afterMessageCount}.`,
    });
  }

  /**
   * 用压缩后的消息序列替换会话历史。
   *
   * 先写一条 compaction 边界留痕，再把替换后的消息作为新分支挂上去：
   * 旧分支保留，可回放/fork；后续 `load` 取到的就是压缩后的短历史。
   */
  async replace(
    sessionId: string,
    messages: AgentMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.compact(sessionId, {
      id: randomUUID(),
      ...(await this.boundaryOf(sessionId)),
      summary:
        typeof metadata?.summary === 'string'
          ? metadata.summary
          : 'Session history replaced by compactor.',
    });
    // 从“无父”重新挂载压缩后的消息，形成一条新的 active 分支。
    const nextLeaf = await this.repository.appendMessages(sessionId, null, messages);
    this.leaves.set(sessionId, nextLeaf);
  }

  /** 列出会话摘要（CLI `ello sessions` 用）。 */
  list() {
    return this.repository.list();
  }

  /** 读取最近一次压缩摘要，可作为系统 section 注入到下一轮提示。 */
  latestCompactionSummary(sessionId: string): Promise<string | null> {
    return this.repository.latestCompactionSummary(sessionId);
  }

  private async leafOf(sessionId: string): Promise<string | null> {
    if (!this.leaves.has(sessionId)) {
      const opened = await this.repository.open(sessionId);
      this.leaves.set(sessionId, opened.leafEntryId);
    }
    return this.leaves.get(sessionId) ?? null;
  }

  private async boundaryOf(
    sessionId: string,
  ): Promise<{ boundaryEntryId?: string }> {
    const leaf = await this.leafOf(sessionId);
    return leaf !== null ? { boundaryEntryId: leaf } : {};
  }
}
