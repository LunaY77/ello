import type { AgentMessage, TranscriptStore } from '@ello/agent';

import type { ArtifactStore } from '../storage/artifact-store.js';

import {
  applyReplacementMap,
  JsonlSessionRepository,
  type AppendCompactionInput,
  type CompactionActiveEntry,
  type CompactionRef,
  type CompactionSessionPort,
  type ContentReplacementRecord,
} from './repository.js';

/**
 * 基于 JSONL 会话树的 `TranscriptStore` 实现，同时背书 `CompactionSessionPort`。
 *
 * 这是内核 `createAgent({ session })` 的会话后端。内核在合适时机调用：
 * - `load`：恢复某个会话当前分支的**模型视图**（投影后的 `modelMessages`）；
 * - `append`：把本轮新增消息追加到当前 leaf 之下；
 *
 * 压缩通过 `CompactionSessionPort` 追加一个带 `firstKeptEntryId` 的 compaction
 * 节点，模型视图在 `load()` 时投影。store 与 `JsonlSessionRepository` 共用同一份
 * JSONL：store 负责内核读写与 leaf 指针缓存，repository 负责投影与会话树产品操作。
 */
export class JsonlSessionStore
  implements TranscriptStore, CompactionSessionPort
{
  /** 底层会话树仓库，store 与 repository 共用同一实例。 */
  readonly repository: JsonlSessionRepository;

  /** 每个会话当前的 active leaf entry id，append 时作为父指针。 */
  private readonly leaves = new Map<string, string | null>();
  /** 每个会话的 tool output replacement latest-wins 快照。 */
  private readonly replacements = new Map<
    string,
    Map<string, ContentReplacementRecord>
  >();
  private readonly artifacts: ArtifactStore;

  constructor(options: {
    readonly sessionDir: string;
    readonly cwd: string;
    readonly artifacts: ArtifactStore;
  }) {
    this.repository = new JsonlSessionRepository(options);
    this.artifacts = options.artifacts;
  }

  /** 读取会话当前分支的**模型视图**（投影后）；顺带刷新 leaf 指针缓存。 */
  async load(sessionId: string): Promise<AgentMessage[]> {
    const opened = await this.repository.open(sessionId);
    for (const replacement of opened.replacements.values()) {
      if (replacement.artifactId !== replacement.sha256) {
        throw new Error(
          `Session ${sessionId} replacement ${replacement.toolCallId} has mismatched artifact id and sha256.`,
        );
      }
      await this.artifacts.verify(replacement.artifactId);
    }
    this.leaves.set(sessionId, opened.leafEntryId);
    this.replacements.set(sessionId, new Map(opened.replacements));
    return opened.modelMessages;
  }

  /** 把本轮新增消息追加到 active leaf 之下。 */
  async append(sessionId: string, messages: AgentMessage[]): Promise<void> {
    const parent = await this.leafOf(sessionId);
    const nextLeaf = await this.repository.appendMessages(
      sessionId,
      parent,
      messages,
    );
    this.leaves.set(sessionId, nextLeaf);
  }

  /**
   * `CompactionSessionPort.loadActivePath`：把 repository 的 raw active path
   * （含 entry id/role）+ 最近 compaction + 投影 token 暴露给 compactor，
   * compactor 据此选切点、定位 `firstKeptEntryId`，不必感知磁盘格式。
   */
  async loadActivePath(sessionId: string): Promise<{
    readonly entries: readonly CompactionActiveEntry[];
    readonly leafEntryId: string | null;
    readonly latestCompaction: CompactionRef | null;
    readonly projectedTokens: number;
  }> {
    const result = await this.repository.loadActivePathForCompaction(sessionId);
    this.leaves.set(sessionId, result.leafEntryId);
    return result;
  }

  /**
   * `CompactionSessionPort.appendCompaction`：追加 compaction 节点并把 leaf
   * 指向它。返回的新 leaf（= compaction 节点 id）写回 leaf 缓存，使后续
   * `append` 挂在 compaction 之下，下一次 `load` 自动投影。
   */
  async appendCompaction(
    sessionId: string,
    input: AppendCompactionInput,
  ): Promise<void> {
    const nextLeaf = await this.repository.appendCompaction(sessionId, input);
    this.leaves.set(sessionId, nextLeaf);
  }

  /** 列出会话摘要（CLI `ello sessions` 用）。 */
  list() {
    return this.repository.list();
  }

  /** 读取 active path 上最近一次 compaction，供 compact 迭代 seed 与累计文件清单。 */
  latestCompaction(sessionId: string): Promise<CompactionRef | null> {
    return this.repository.latestCompaction(sessionId);
  }

  /** 读取最近一次手动 `/summary` 纪要，仅供 `/summary` 迭代自己的 seed。 */
  latestSummary(sessionId: string): Promise<{ summary: string } | null> {
    return this.repository.latestSummary(sessionId);
  }

  /** 追加一条手动 `/summary` 纪要（旁路记录，不进 active path / modelMessages）。 */
  appendSummary(sessionId: string, summary: string): Promise<void> {
    return this.repository.appendSummary(sessionId, summary);
  }

  /** 追加 replacement 后同步更新当前 session 的内存快照。 */
  async appendContentReplacement(
    sessionId: string,
    input: Omit<ContentReplacementRecord, 'kind' | 'createdAt'>,
  ): Promise<void> {
    const snapshot = this.replacements.get(sessionId);
    if (snapshot === undefined) {
      throw new Error(
        `Content replacement snapshot is not loaded for session ${sessionId}.`,
      );
    }
    await this.repository.appendContentReplacement(sessionId, input);
    snapshot.set(input.toolCallId, {
      kind: 'content-replacement',
      ...input,
      createdAt: new Date().toISOString(),
    });
  }

  /** 只读内存快照应用 replacement，不触发 transcript IO。 */
  applyContentReplacements(
    sessionId: string,
    messages: readonly AgentMessage[],
  ): AgentMessage[] {
    const snapshot = this.replacements.get(sessionId);
    if (snapshot === undefined) {
      throw new Error(
        `Content replacement snapshot is not loaded for session ${sessionId}.`,
      );
    }
    return snapshot.size === 0
      ? [...messages]
      : applyReplacementMap(messages, snapshot);
  }

  /** 切换 leaf 后重载 leaf 与 replacement 快照。 */
  async checkout(sessionId: string, entryId: string | null): Promise<void> {
    await this.repository.checkout(sessionId, entryId);
    await this.load(sessionId);
  }

  private async leafOf(sessionId: string): Promise<string | null> {
    if (!this.leaves.has(sessionId)) {
      await this.load(sessionId);
    }
    const leaf = this.leaves.get(sessionId);
    if (leaf === undefined) {
      throw new Error(`Session leaf cache is not loaded for ${sessionId}.`);
    }
    return leaf;
  }
}
