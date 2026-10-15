/**
 * Thread 消息历史投影、纯消息压缩策略和手动压缩持久化入口。
 *
 * `createThreadCompactor()` 只处理消息，不读取 Thread log 或 record seq。Thread 调用方负责先从
 * records 投影历史，再依据压缩报告写入 `compaction` record，确保消息事实源始终只有 Thread。
 */
import type { ThreadSnapshot } from '../../protocol/v1/index.js';
import type { ThreadRecord } from '../../storage/threads/thread-record.js';
import {
  createAgentMessage,
  type AgentMessage,
  type AgentUsage,
  type MessageCompactionReport,
  type MessageCompactor,
  type ModelCompactor,
} from '../agent/engine/index.js';
import { renderPromptTemplate } from '../agent/index.js';
import { createAgentRegistry } from '../agent/subagents/index.js';
import {
  loadCodingAgentConfig,
  type CodingAgentConfig,
  type ContextCompactionConfig,
} from '../config/index.js';
import { createModelRegistry } from '../model/index.js';

import type { ThreadStore } from './store.js';

const COMPACTION_NAME = 'ello-thread-compactor';
const CHECKPOINT_PREFIX = '<compact-checkpoint>\n';
const CHECKPOINT_SUFFIX = '\n</compact-checkpoint>';

export interface ThreadCompactorOptions {
  readonly config: CodingAgentConfig;
  /** 产品装配阶段解析出的有效窗口；用于防止调用方传入更大的运行时窗口。 */
  readonly contextWindow?: number;
  readonly force?: boolean;
  /**
   * 在 Thread `compact` 模块 中执行 `generateCheckpoint` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   * - `previousCheckpoint`: `generateCheckpoint` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `signal`: 调用方拥有的取消信号；触发后当前异步操作必须尽快终止并保留取消原因。
   *
   * Returns:
   * - Promise 在 Thread `compact` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  readonly generateCheckpoint?: (
    messages: ReadonlyArray<AgentMessage>,
    previousCheckpoint: string | undefined,
    signal: AbortSignal,
  ) => Promise<string>;
}

export interface ManualCompactionOptions {
  readonly force?: boolean;
  readonly turnId?: string;
  readonly signal?: AbortSignal;
}

export interface ThreadCompactionService {
  /**
   * 对指定 Thread 的当前消息历史执行压缩并持久化边界。
   *
   * Args:
   * - `threadId`: 要压缩的 Thread 标识。
   * - `options`: 手动压缩开关和归属 turn；省略 turn 时使用最后一条 transcript entry。
   *
   * Returns:
   * - 返回压缩报告；没有合法切分边界时返回 `null`。
   */
  compactNow(
    threadId: string,
    options?: ManualCompactionOptions,
  ): Promise<PersistedThreadCompactionReport | null>;
}

export interface PersistedThreadCompactionReport extends MessageCompactionReport {
  readonly id: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly createdAt: string;
}

/**
 * 创建不接触 Thread 持久化的消息压缩器。
 *
 * Args:
 * - `options`: 已验证配置、窗口限制和可选 checkpoint 测试替身。
 *
 * Returns:
 * - 返回只依赖消息快照、上下文窗口和中断信号的压缩器。
 */
export function createThreadCompactor(
  options: ThreadCompactorOptions,
): MessageCompactor {
  const generateCheckpoint = async (
    messagesToCompact: ReadonlyArray<AgentMessage>,
    previousCheckpoint: string | undefined,
    signal: AbortSignal,
    compact: ModelCompactor['compact'],
  ): Promise<{
    readonly summary: string;
    readonly usage?: AgentUsage;
  }> => {
    if (options.generateCheckpoint !== undefined) {
      return {
        summary: await options.generateCheckpoint(
          messagesToCompact,
          previousCheckpoint,
          signal,
        ),
      };
    }
    const result = await compact({
      messages:
        previousCheckpoint === undefined
          ? messagesToCompact
          : [summaryMessage(previousCheckpoint), ...messagesToCompact],
      prompt: renderPromptTemplate('compact'),
      signal,
    });
    return { summary: result.text, usage: result.usage };
  };

  return {
    name: COMPACTION_NAME,
    async compact(input) {
      const contextWindow = Math.min(
        input.contextWindow,
        options.contextWindow ?? input.contextWindow,
      );
      const checkpoint = splitCheckpoint(input.messages);
      const tokensBefore = input.messages.reduce(
        (total, message) => total + estimateTokens(message),
        0,
      );
      if (
        options.force !== true &&
        input.force !== true &&
        !shouldCompact(
          tokensBefore,
          contextWindow,
          options.config.context.compaction,
        )
      ) {
        return null;
      }
      const cut = findCutIndex(
        checkpoint.messages,
        options.config.context.compaction,
        options.force === true || input.force === true,
      );
      if (cut === null) return null;
      const toSummarize = checkpoint.messages.slice(0, cut);
      const kept = checkpoint.messages.slice(cut);
      if (toSummarize.length === 0 || kept.length === 0) return null;
      await input.onStart?.({
        beforeMessageCount: input.messages.length,
        tokensBefore,
      });
      const generated = await generateCheckpoint(
        toSummarize,
        checkpoint.previous,
        input.signal,
        input.compact,
      );
      const normalizedSummary = generated.summary.trim();
      if (normalizedSummary === '') {
        throw new Error('Compaction model returned an empty checkpoint.');
      }
      return {
        messages: [summaryMessage(normalizedSummary), ...kept],
        ...(generated.usage === undefined ? {} : { usage: generated.usage }),
        report: {
          compactor: COMPACTION_NAME,
          beforeMessageCount: input.messages.length,
          afterMessageCount: kept.length + 1,
          summary: normalizedSummary,
          keptMessageCount: kept.length,
          tokensBefore,
          metadata: {
            summarizedMessages: toSummarize.length,
            keptMessages: kept.length,
          },
        },
      };
    },
  };
}

/**
 * 创建手动 Thread 压缩服务。
 *
 * Args:
 * - `options.logs`: Thread records 的唯一持久化入口。
 * - `options.snapshot`: 选择模型配置和默认 turn 的当前 Thread 快照。
 *
 * Returns:
 * - 返回读取 records、调用纯压缩器并写入 compaction record 的服务。
 */
export async function createProductionThreadCompactor(options: {
  readonly store: ThreadStore;
  readonly snapshot: ThreadSnapshot;
  readonly compact: ModelCompactor['compact'];
}): Promise<ThreadCompactionService> {
  const config = await loadCodingAgentConfig({
    cwd: options.snapshot.thread.cwd,
    initial_mode: options.snapshot.settings.mode,
  });
  const agents = await createAgentRegistry(config);
  const agentName =
    options.snapshot.settings.agent === 'primary'
      ? config.default_agent
      : options.snapshot.settings.agent;
  const definition = agents.get(agentName);
  const model = createModelRegistry(config).resolveSelector(definition.model);

  return {
    async compactNow(threadId, manual = {}) {
      const records = await options.store.read(threadId);
      const view = compactionView(records);
      const compactor = createThreadCompactor({
        config,
        force: manual.force === true,
      });
      const compacted = await compactor.compact({
        messages: view.projectedMessages,
        contextWindow: model.contextWindow,
        signal: manual.signal ?? new AbortController().signal,
        compact: options.compact,
      });
      if (compacted === null) return null;
      const turnId = manual.turnId ?? view.entries.at(-1)?.turnId;
      if (turnId === undefined) {
        throw new Error(
          'Compaction requires a transcript entry with a turn id.',
        );
      }
      const record = await appendThreadCompaction({
        store: options.store,
        threadId,
        turnId,
        view,
        report: compacted.report,
      });
      return {
        ...compacted.report,
        id: `compaction-${record.seq}`,
        threadId,
        turnId,
        createdAt: record.createdAt,
      };
    },
  };
}

/**
 * 从 Thread records 投影当前模型历史和压缩边界。
 *
 * Args:
 * - `records`: 已按 seq 验证并排序的完整 Thread record 列表。
 *
 * Returns:
 * - 返回当前有效 transcript entries、模型消息、估算 token 和最新压缩 record。
 */
export function compactionView(records: ReadonlyArray<ThreadRecord>): {
  readonly entries: ReadonlyArray<CompactionEntry>;
  readonly projectedMessages: ReadonlyArray<AgentMessage>;
  readonly projectedTokens: number;
  readonly latestCompaction?: Extract<ThreadRecord, { kind: 'compaction' }>;
} {
  const latestCompaction = [...records]
    .reverse()
    .find(
      (record): record is Extract<ThreadRecord, { kind: 'compaction' }> =>
        record.kind === 'compaction',
    );
  const transcript = records.filter(
    (record): record is Extract<ThreadRecord, { kind: 'transcript.entry' }> =>
      record.kind === 'transcript.entry',
  );
  const entries = transcript
    .filter(
      (record) =>
        latestCompaction === undefined ||
        record.seq >= latestCompaction.firstKeptSeq,
    )
    .map((record) => ({
      seq: record.seq,
      turnId: record.turnId,
      role: record.role,
      message: parseAgentMessage(record.message),
    }));
  const projectedMessages = [
    ...(latestCompaction === undefined
      ? []
      : [summaryMessage(latestCompaction.summary)]),
    ...entries.map((entry) => entry.message),
  ];
  return {
    entries,
    projectedMessages,
    projectedTokens: projectedMessages.reduce(
      (total, message) => total + estimateTokens(message),
      0,
    ),
    ...(latestCompaction === undefined ? {} : { latestCompaction }),
  };
}

export interface CompactionEntry {
  readonly seq: number;
  readonly turnId: string;
  readonly role: AgentMessage['role'];
  readonly message: AgentMessage;
}

/**
 * 把纯消息压缩报告转换成 Thread compaction record。
 *
 * Args:
 * - `input.logs`: record 写入端口。
 * - `input.threadId`: 压缩所属 Thread。
 * - `input.turnId`: 压缩所属 turn。
 * - `input.view`: 压缩前由同一批 records 投影出的消息与 seq 映射。
 * - `input.report`: 纯压缩器返回的边界与 checkpoint 数据。
 *
 * Returns:
 * - Promise resolve 表示 compaction record 已持久化。
 */
export async function appendThreadCompaction(input: {
  readonly store: Pick<ThreadStore, 'append'>;
  readonly threadId: string;
  readonly turnId: string;
  readonly view: ReturnType<typeof compactionView>;
  readonly report: MessageCompactionReport;
}): Promise<Extract<ThreadRecord, { kind: 'compaction' }>> {
  const firstKept = input.view.entries.at(-input.report.keptMessageCount);
  if (firstKept === undefined) {
    throw new Error(
      `Compaction kept ${input.report.keptMessageCount} messages outside the current Thread history.`,
    );
  }
  const record = await input.store.append(input.threadId, {
    kind: 'compaction',
    turnId: input.turnId,
    summary: input.report.summary,
    firstKeptSeq: firstKept.seq,
    tokensBefore: input.report.tokensBefore,
    beforeMessageCount: input.report.beforeMessageCount,
    afterMessageCount: input.report.afterMessageCount,
    keptMessageCount: input.report.keptMessageCount,
  });
  if (record.kind !== 'compaction') {
    throw new Error(`Expected compaction record, received ${record.kind}.`);
  }
  return record;
}

function shouldCompact(
  tokens: number,
  contextWindow: number,
  settings: ContextCompactionConfig,
): boolean {
  const threshold = Math.max(
    1,
    Math.ceil((contextWindow * settings.threshold_percent) / 100),
  );
  return settings.auto && tokens >= threshold;
}

function findCutIndex(
  messages: ReadonlyArray<AgentMessage>,
  settings: ContextCompactionConfig,
  force: boolean,
): number | null {
  if (messages.length < 2) return null;
  if (force) {
    const userIndexes = messages.flatMap((message, index) =>
      message.role === 'user' ? [index] : [],
    );
    const tailStart = userIndexes.at(-settings.tail_turns);
    if (tailStart !== undefined && tailStart > 0) return tailStart;
  }
  let accumulated = 0;
  let tokenCut = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      throw new Error(`Compaction message index ${index} is missing.`);
    }
    accumulated += estimateTokens(message);
    tokenCut = index;
    if (accumulated >= settings.preserve_recent_tokens) break;
  }
  for (let index = tokenCut; index > 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      throw new Error(`Compaction message index ${index} is missing.`);
    }
    if (message.role === 'user') return index;
  }
  if (settings.split_turns) {
    for (let index = tokenCut; index > 0; index -= 1) {
      const message = messages[index];
      if (message === undefined) {
        throw new Error(`Compaction message index ${index} is missing.`);
      }
      if (message.role === 'assistant') return index;
    }
  }
  for (let index = tokenCut; index > 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      throw new Error(`Compaction message index ${index} is missing.`);
    }
    if (message.role !== 'tool') return index;
  }
  return null;
}

function splitCheckpoint(messages: ReadonlyArray<AgentMessage>): {
  readonly previous: string | undefined;
  readonly messages: ReadonlyArray<AgentMessage>;
} {
  const first = messages[0];
  if (
    first === undefined ||
    first.role !== 'user' ||
    typeof first.content !== 'string' ||
    !first.content.startsWith(CHECKPOINT_PREFIX) ||
    !first.content.endsWith(CHECKPOINT_SUFFIX)
  ) {
    return { previous: undefined, messages };
  }
  return {
    previous: first.content.slice(
      CHECKPOINT_PREFIX.length,
      -CHECKPOINT_SUFFIX.length,
    ),
    messages: messages.slice(1),
  };
}

function summaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: `${CHECKPOINT_PREFIX}${summary}${CHECKPOINT_SUFFIX}`,
  };
}

/**
 * 从已经持久化/投影的消息构造稳定 checkpoint。
 *
 * 这是 Context Management 的宿主投影，不尝试生成新的事实；每条旧消息只
 * 提供角色、顺序和有界内容，后续模型仍可通过 durable transcript/artifact
 * 读取完整细节。固定上限保证 checkpoint 自身不会成为新的超大 newest message。
 */
function estimateTokens(message: AgentMessage): number {
  return Math.ceil(messageText(message).length / 4);
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content;
  const serialized = JSON.stringify(message.content);
  if (serialized === undefined) {
    throw new Error(
      `Message content for role '${message.role}' is not serializable.`,
    );
  }
  return serialized;
}

function parseAgentMessage(value: unknown): AgentMessage {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Transcript message must be an object.');
  }
  const role = Reflect.get(value, 'role');
  const content = Reflect.get(value, 'content');
  if (
    (role !== 'system' &&
      role !== 'user' &&
      role !== 'assistant' &&
      role !== 'tool') ||
    (typeof content !== 'string' && !Array.isArray(content))
  ) {
    throw new Error('Transcript message has an invalid role or content.');
  }
  return createAgentMessage({ role, content });
}
