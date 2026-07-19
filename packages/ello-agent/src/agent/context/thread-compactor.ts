import {
  loadCodingAgentConfig,
  type CodingAgentConfig,
  type ContextCompactionConfig,
} from '../../config/index.js';
import type { ThreadSnapshot } from '../../protocol/v1/index.js';
import { ThreadLogRepository } from '../../storage/threads/thread-log.js';
import type { ThreadRecord } from '../../storage/threads/thread-record.js';
import type {
  AgentMessage,
  AgentRunContext,
  CompactionPort,
  SessionCompactionReport,
} from '../engine/index.js';
import { createProviderRegistry } from '../providers/catalog/index.js';
import { runInternalAgent } from '../subagents/internal-runner.js';
import {
  createAgentRegistry,
  type AgentRegistry,
} from '../subagents/registry.js';

const COMPACTION_NAME = 'ello-thread-compactor';

export interface ThreadCompactorOptions {
  readonly logs: ThreadLogRepository;
  readonly config: CodingAgentConfig;
  readonly profileName: string;
  readonly contextWindow: number;
  readonly agentRegistry?: AgentRegistry;
  readonly generateCheckpoint?: (
    messages: readonly AgentMessage[],
    previousCheckpoint?: string,
  ) => Promise<string>;
}

export interface ManualCompactionOptions {
  readonly force?: boolean;
  readonly turnId?: string;
}

export interface ThreadCompactor extends CompactionPort {
  compactNow(
    threadId: string,
    options?: ManualCompactionOptions,
  ): Promise<SessionCompactionReport | null>;
}

export function createThreadCompactor(
  options: ThreadCompactorOptions,
): ThreadCompactor {
  let registryTask: Promise<AgentRegistry> | undefined;
  const getRegistry = async (): Promise<AgentRegistry> => {
    if (options.agentRegistry !== undefined) return options.agentRegistry;
    return (registryTask ??= createAgentRegistry(options.config));
  };

  const generateCheckpoint = async (
    messages: readonly AgentMessage[],
    previousCheckpoint: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    if (options.generateCheckpoint !== undefined) {
      return options.generateCheckpoint(messages, previousCheckpoint);
    }
    const registry = await getRegistry();
    const providerRegistry = createProviderRegistry(options.config);
    const conversation = messages
      .map((message) => `### ${message.role}\n${messageText(message)}`)
      .join('\n\n');
    const prompt = `${previousCheckpoint === undefined ? '' : `<previous-compact>\n${previousCheckpoint}\n</previous-compact>\n`}<conversation>\n${conversation}\n</conversation>`;
    return runInternalAgent({
      definition: registry.get('compact'),
      prompt,
      profileName: options.profileName,
      config: options.config,
      providerRegistry,
      ...(signal === undefined ? {} : { signal }),
    });
  };

  const compact = async (
    threadId: string,
    force: boolean,
    turnId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SessionCompactionReport | null> => {
    const records = await options.logs.read(threadId);
    const view = compactionView(records);
    if (
      !force &&
      !shouldCompact(
        view.projectedTokens,
        options.contextWindow,
        options.config.context.compaction,
      )
    ) {
      return null;
    }
    const cut = findCutIndex(
      view.entries,
      options.config.context.compaction,
      force,
    );
    if (cut === null) return null;
    const toSummarize = view.entries
      .slice(0, cut)
      .map((entry) => entry.message);
    if (toSummarize.length === 0) return null;
    const firstKept = view.entries[cut];
    if (firstKept === undefined) return null;
    const summary = await generateCheckpoint(
      serializeForCompact(toSummarize, options.config.context.compaction),
      view.latestCompaction?.summary,
      signal,
    );
    if (summary.trim() === '') {
      throw new Error('Compaction model returned an empty checkpoint.');
    }
    const effectiveTurnId = turnId ?? view.entries.at(-1)?.turnId;
    if (effectiveTurnId === undefined) return null;
    await options.logs.append(threadId, {
      kind: 'compaction',
      turnId: effectiveTurnId,
      summary: summary.trim(),
      firstKeptSeq: firstKept.seq,
      tokensBefore: view.projectedTokens,
    });
    return {
      compactor: COMPACTION_NAME,
      beforeMessageCount: view.projectedMessages.length,
      afterMessageCount: view.entries.length - cut + 1,
      metadata: {
        tokensBefore: view.projectedTokens,
        firstKeptSeq: firstKept.seq,
        summarizedMessages: toSummarize.length,
        keptMessages: view.entries.length - cut,
      },
    };
  };

  return {
    name: COMPACTION_NAME,
    maybeCompact: (threadId, ctx) =>
      compact(threadId, false, readTurnId(ctx), ctx.signal),
    compactNow: (threadId, manual = {}) =>
      compact(threadId, manual.force === true, manual.turnId, undefined),
  };
}

export async function createProductionThreadCompactor(options: {
  readonly logs: ThreadLogRepository;
  readonly snapshot: ThreadSnapshot;
}): Promise<ThreadCompactor> {
  const config = await loadCodingAgentConfig({
    cwd: options.snapshot.thread.cwd,
    initial_mode: options.snapshot.settings.mode,
  });
  const providerRegistry = createProviderRegistry(config);
  const model = providerRegistry.getModel(options.snapshot.settings.model);
  return createThreadCompactor({
    logs: options.logs,
    config,
    profileName: options.snapshot.settings.profile,
    contextWindow: model.limit.context,
  });
}

export function compactionView(records: readonly ThreadRecord[]): {
  readonly entries: readonly CompactionEntry[];
  readonly projectedMessages: readonly AgentMessage[];
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
      message: record.message as AgentMessage,
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

interface CompactionEntry {
  readonly seq: number;
  readonly turnId: string;
  readonly role: AgentMessage['role'];
  readonly message: AgentMessage;
}

function shouldCompact(
  tokens: number,
  contextWindow: number,
  settings: ContextCompactionConfig,
): boolean {
  return (
    settings.auto &&
    tokens > Math.max(1, contextWindow - settings.reserved_tokens)
  );
}

function findCutIndex(
  entries: readonly CompactionEntry[],
  settings: ContextCompactionConfig,
  force: boolean,
): number | null {
  if (entries.length < 2) return null;
  if (force) {
    const userIndexes = entries.flatMap((entry, index) =>
      entry.role === 'user' ? [index] : [],
    );
    const tailStart = userIndexes.at(-settings.tail_turns);
    if (tailStart !== undefined && tailStart > 0) return tailStart;
  }
  let accumulated = 0;
  let tokenCut = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    accumulated += estimateTokens(entries[index]!.message);
    tokenCut = index;
    if (accumulated >= settings.preserve_recent_tokens) break;
  }
  for (let index = tokenCut; index > 0; index -= 1) {
    if (entries[index]!.role === 'user') return index;
  }
  if (settings.split_turns) {
    for (let index = tokenCut; index > 0; index -= 1) {
      if (entries[index]!.role === 'assistant') return index;
    }
  }
  for (let index = tokenCut; index > 0; index -= 1) {
    if (entries[index]!.role !== 'tool') return index;
  }
  return null;
}

function serializeForCompact(
  messages: readonly AgentMessage[],
  settings: ContextCompactionConfig,
): readonly AgentMessage[] {
  if (!settings.prune_tool_output) return messages;
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    const text = messageText(message);
    return {
      ...message,
      content: text.slice(0, settings.tool_output_max_chars),
    } as unknown as AgentMessage;
  });
}

function summaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: `<compact-checkpoint>\n${summary}\n</compact-checkpoint>`,
  } as AgentMessage;
}

function estimateTokens(message: AgentMessage): number {
  return Math.ceil(messageText(message).length / 4);
}

function messageText(message: AgentMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : (JSON.stringify(message.content) ?? '');
}

function readTurnId(ctx: AgentRunContext): string | undefined {
  const value = ctx.metadata.turnId;
  return typeof value === 'string' ? value : undefined;
}
