import type {
  AgentMessage,
  SessionCompactionReport,
  SessionCompactor,
  SessionStore,
} from '@ello/agent';

import type {
  AppendCompactionInput,
  CompactionActiveEntry,
  CompactionRef,
  CompactionSessionPort,
} from '../session/repository.js';

/**
 * 长会话上下文压缩器（投影模型）。
 *
 * 压缩通过 {@link CompactionSessionPort} 追加一个带 `firstKeptEntryId` 的
 * compaction 节点，raw JSONL 完整保留，模型视图在 `store.load()` 时投影。
 * compactor 因此只关心：
 * - 触发判定：基于端口返回的**投影后** token（`projectedTokens`）；
 * - 选切点：从尾部保留 `keepRecentTokens`，吸附到合法回合边界，绝不切在 tool result
 *   （否则产生孤儿 result），单 turn 超预算时按 `splitTurns` 切到 assistant 边界；
 * - 生成 summary：从上一次 compaction 的 `firstKeptEntryId` 起到切点，喂给迭代模板；
 * - 累计文件清单：与上一次 compaction 的 `details` 合并，既写 `details`（机器/TUI）
 *   又以 `<read-files>`/`<modified-files>` 双写进 summary 正文（模型）。
 *
 * 触发时机由内核在回合之间（`run.completed` 后）调用 `maybeCompact` 决定。
 */

/** 压缩配置。 */
export interface CompactionSettings {
  /** 是否启用压缩。 */
  readonly enabled: boolean;
  /** 为输出和系统预留的 token，触发阈值 = `contextWindow - reserveTokens`。 */
  readonly reserveTokens: number;
  /** 压缩后从尾部保留的“近期消息”token 预算。 */
  readonly keepRecentTokens: number;
  /** 至少保留最近几个 user turn，避免只按 token 切碎交互语义。 */
  readonly tailTurns: number;
  /** 单 turn 自身超预算时，允许切到 turn 内 assistant 边界（split turn）。 */
  readonly splitTurns: boolean;
  /** 是否裁剪 tool output 后再喂给 compact 模型。 */
  readonly pruneToolOutput: boolean;
  /** tool output 裁剪上限。 */
  readonly toolOutputMaxChars: number;
}

/** 默认压缩配置。 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  tailTurns: 2,
  splitTurns: true,
  pruneToolOutput: false,
  toolOutputMaxChars: 2000,
};

/** compact checkpoint 生成回调的选项。 */
export interface CompactCheckpointOptions {
  /** 上一次压缩的 checkpoint 正文（存在则走迭代更新模板）。 */
  readonly previousCheckpoint?: string;
  /** 本次 checkpoint 的 token 上限建议（调用方据此设置 max output）。 */
  readonly maxTokens?: number;
}

/**
 * checkpoint 生成回调：由会话装配处注入，内部走一次性模型补全生成 checkpoint。
 * 压缩器本身不持有模型适配器，以此保持与具体 provider 解耦。
 */
export type GenerateCompactCheckpoint = (
  messages: readonly AgentMessage[],
  opts: CompactCheckpointOptions,
) => Promise<string>;

/** {@link createSessionCompactor} 的依赖。 */
export interface SessionCompactorDeps {
  /** 模型上下文窗口（token），用于触发判定。 */
  readonly contextWindow: number;
  /** checkpoint 生成回调。 */
  readonly generateCheckpoint: GenerateCompactCheckpoint;
  /**
   * 会话端口：compactor 闭包持有它，绕开泛型 `store` 直接读 raw active path、
   * 追加 compaction 节点。投影发生在 `load()`，compactor 不感知磁盘格式。
   */
  readonly port: CompactionSessionPort;
  /** 覆盖默认压缩配置。 */
  readonly settings?: Partial<CompactionSettings>;
}

/** 估算单条消息的 token 数（`ceil(chars/4)` 启发式，遍历 part）。 */
export function estimateTokens(message: AgentMessage): number {
  const { content } = message as { content: unknown };
  const chars =
    typeof content === 'string' ? content.length : measureParts(content);
  return Math.ceil(chars / 4);
}

/** 触发判定：投影后 token 超过「窗口 - 预留」即需要压缩。 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  return (
    settings.enabled && contextTokens > contextWindow - settings.reserveTokens
  );
}

/**
 * 选切点：在 `[start, n)` 区间内，从尾部累加保留 `keepRecentTokens`，
 * 再吸附到合法回合边界，返回 kept 起点下标 `cut`。
 *
 * `[start, cut)` 进 summary，`[cut, n)` 保留；`firstKeptEntryId = entries[cut].id`。
 * - 优先吸附到 `user` 边界（整回合保留）；
 * - `splitTurns` 且无 user 边界时退到 `assistant` 边界（切碎超大单 turn）；
 * - 最后退到非 `tool` 边界，绝不让 kept 以 tool result 起头（避免孤儿 result）；
 * - 无合法切点（cut <= start）时返回 null。
 */
export function findCutIndex(
  entries: readonly CompactionActiveEntry[],
  start: number,
  settings: CompactionSettings,
): number | null {
  const n = entries.length;
  if (n - start <= 0) {
    return null;
  }
  // 从尾部往回累加，直到攒够 keepRecentTokens，得到 token 维度的初始切点。
  let acc = 0;
  let tokenCut = n;
  for (let i = n - 1; i >= start; i -= 1) {
    acc += estimateTokens(entries[i]!.message);
    tokenCut = i;
    if (acc >= settings.keepRecentTokens) {
      break;
    }
  }

  const turnCut = findTailTurnCut(entries, settings.tailTurns, start);
  const initialCut = turnCut === null ? tokenCut : Math.min(tokenCut, turnCut);

  // 优先吸附到 (start, initialCut] 的最近 user 边界（整回合保留）。
  for (let i = initialCut; i > start; i -= 1) {
    if (entries[i]!.role === 'user') {
      return i;
    }
  }
  // split turn：单 turn 超预算且无 user 边界，退到 assistant 边界。
  if (settings.splitTurns) {
    for (let i = initialCut; i > start; i -= 1) {
      if (entries[i]!.role === 'assistant') {
        return i;
      }
    }
  }
  // 退到最近非 tool 边界（避免孤儿 tool result）。
  for (let i = initialCut; i > start; i -= 1) {
    if (entries[i]!.role !== 'tool') {
      return i;
    }
  }
  return null;
}

/** 从被压缩消息里抽取读取/修改过的文件路径。 */
export function extractFileOps(messages: readonly AgentMessage[]): {
  readonly readFiles: string[];
  readonly modifiedFiles: string[];
} {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      collectFileChanges(part, modifiedFiles);
      if (!isToolCallPart(part)) {
        continue;
      }
      const input = (part.input ?? part.args) as
        | Record<string, unknown>
        | undefined;
      const file = typeof input?.path === 'string' ? input.path : undefined;
      if (file === undefined) {
        continue;
      }
      if (/^(write|edit|apply_patch|create)/u.test(part.toolName)) {
        modifiedFiles.add(file);
      } else if (/^(read|cat|open)/u.test(part.toolName)) {
        readFiles.add(file);
      }
    }
  }
  return {
    readFiles: [...readFiles].sort(),
    modifiedFiles: [...modifiedFiles].sort(),
  };
}

function collectFileChanges(part: unknown, modifiedFiles: Set<string>): void {
  if (typeof part !== 'object' || part === null) {
    return;
  }
  const output = (part as { output?: unknown; result?: unknown }).output ??
    (part as { output?: unknown; result?: unknown }).result;
  if (typeof output !== 'object' || output === null) {
    return;
  }
  const metadata = (output as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return;
  }
  const fileChanges = (metadata as { fileChanges?: unknown }).fileChanges;
  if (!Array.isArray(fileChanges)) {
    return;
  }
  for (const change of fileChanges) {
    if (
      typeof change === 'object' &&
      change !== null &&
      typeof (change as { path?: unknown }).path === 'string'
    ) {
      modifiedFiles.add((change as { path: string }).path);
    }
  }
}

/**
 * 把本次抽取的文件清单与上一次 compaction 的 `details` 合并累计（去重、排序）。
 * 跨多次压缩继承，保证早期读/改过的文件路径不因压缩而丢失。
 */
export function mergeFileDetails(
  previous: CompactionRef['details'] | undefined,
  current: { readonly readFiles: string[]; readonly modifiedFiles: string[] },
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set<string>([
    ...(previous?.readFiles ?? []),
    ...current.readFiles,
  ]);
  const modified = new Set<string>([
    ...(previous?.modifiedFiles ?? []),
    ...current.modifiedFiles,
  ]);
  return {
    readFiles: [...read].sort(),
    modifiedFiles: [...modified].sort(),
  };
}

/** 把文件清单以 `<read-files>` / `<modified-files>` 标签追加到 summary 正文尾部。 */
export function appendFileManifest(
  checkpoint: string,
  files: {
    readonly readFiles: readonly string[];
    readonly modifiedFiles: readonly string[];
  },
): string {
  const parts = [checkpoint.trim()];
  if (files.readFiles.length > 0) {
    parts.push(`<read-files>\n${files.readFiles.join('\n')}\n</read-files>`);
  }
  if (files.modifiedFiles.length > 0) {
    parts.push(
      `<modified-files>\n${files.modifiedFiles.join('\n')}\n</modified-files>`,
    );
  }
  return parts.join('\n\n');
}

/** 序列化历史喂给 compact 模型：可选把 tool-result 截断到 `toolOutputMaxChars`。 */
export function serializeForCompact(
  messages: readonly AgentMessage[],
  options: {
    readonly pruneToolOutput?: boolean;
    readonly toolOutputMaxChars?: number;
  } = {},
): AgentMessage[] {
  const maxChars = options.toolOutputMaxChars ?? 2000;
  return messages.map((message) => {
    if (message.role !== 'tool' || options.pruneToolOutput !== true) {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    const text =
      typeof content === 'string' ? content : JSON.stringify(content);
    return {
      ...message,
      content: text.slice(0, maxChars),
    } as unknown as AgentMessage;
  });
}

export function renderCompactConversation(
  messages: readonly AgentMessage[],
): string {
  return messages.map(serializeCompactMessage).join('\n\n');
}

/**
 * 构造长会话压缩器 {@link SessionCompactor}。
 *
 * 触发流程（`maybeCompact`）：
 * 1. `port.loadActivePath` 取 raw entries + 最近 compaction + 投影后 token；
 * 2. `projectedTokens` 未超阈值则返回 null（不压缩）；
 * 3. 从上一次 `firstKeptEntryId`（或起点）到切点选 summarize 区间，处理 split turn；
 * 4. 调 `generateCheckpoint`（迭代 seed = 上一次 summary）生成 summary，追加累计文件清单；
 * 5. `port.appendCompaction` 追加 compaction 节点并把 leaf 指向它；
 *    下一轮 `store.load()` 自动投影成 `[summary, ...kept]`。
 */
export function createSessionCompactor(
  deps: SessionCompactorDeps,
): SessionCompactor {
  const settings: CompactionSettings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...deps.settings,
  };

  return {
    name: 'ello-session-compactor',
    async maybeCompact(
      sessionId: string,
      _store: SessionStore,
    ): Promise<SessionCompactionReport | null> {
      const active = await deps.port.loadActivePath(sessionId);
      if (
        !shouldCompact(active.projectedTokens, deps.contextWindow, settings)
      ) {
        return null;
      }

      const { entries, leafEntryId, latestCompaction } = active;
      // summarize 起点 = 上一次 compaction 的 firstKeptEntryId（无则 session 起点）。
      const start =
        latestCompaction === null
          ? 0
          : Math.max(
              0,
              entries.findIndex(
                (entry) => entry.id === latestCompaction.firstKeptEntryId,
              ),
            );

      const cut = findCutIndex(entries, start, settings);
      if (cut === null) {
        return null;
      }
      const toSummarize = entries
        .slice(start, cut)
        .map((entry) => entry.message);
      if (toSummarize.length === 0) {
        return null;
      }
      const firstKeptEntryId = entries[cut]!.id;

      const previousSummary = latestCompaction?.summary;
      const raw = await deps.generateCheckpoint(
        serializeForCompact(toSummarize, {
          pruneToolOutput: settings.pruneToolOutput,
          toolOutputMaxChars: settings.toolOutputMaxChars,
        }),
        {
          ...(previousSummary !== undefined
            ? { previousCheckpoint: previousSummary }
            : {}),
          maxTokens: Math.floor(settings.reserveTokens * 0.8),
        },
      );
      const details = mergeFileDetails(
        latestCompaction?.details,
        extractFileOps(toSummarize),
      );
      const summary = appendFileManifest(raw, details);

      const input: AppendCompactionInput = {
        parentId: leafEntryId,
        firstKeptEntryId,
        summary,
        tokensBefore: active.projectedTokens,
        details,
      };
      await deps.port.appendCompaction(sessionId, input);

      const keptMessages = entries.length - cut;
      return {
        compactor: 'ello-session-compactor',
        beforeMessageCount: entries.length,
        afterMessageCount: keptMessages + 1,
        metadata: {
          tokensBefore: active.projectedTokens,
          firstKeptEntryId,
          summarizedMessages: toSummarize.length,
          keptMessages,
        },
      };
    },
  };
}

/**
 * 找到「保留最近 `tailTurns` 个 user turn」的起点下标（即第 tailTurns 个 user）。
 * 只在 `>= start` 区间内计数，返回 null 表示不足 tailTurns 个 turn。
 */
function findTailTurnCut(
  entries: readonly CompactionActiveEntry[],
  tailTurns: number,
  start: number,
): number | null {
  if (tailTurns <= 0) {
    return null;
  }
  let seen = 0;
  for (let i = entries.length - 1; i >= start; i -= 1) {
    if (entries[i]!.role !== 'user') {
      continue;
    }
    seen += 1;
    if (seen >= tailTurns) {
      return i;
    }
  }
  return null;
}

/** 累加 part 数组的字符数（用于 token 估算）。 */
function measureParts(content: unknown): number {
  if (!Array.isArray(content)) {
    return content === undefined || content === null
      ? 0
      : JSON.stringify(content).length;
  }
  let chars = 0;
  for (const part of content) {
    const type = (part as { type?: string }).type;
    if (type === 'image' || type === 'file') {
      // 图片/文件按固定开销近似计入（约 4800 字符）。
      chars += 4800;
      continue;
    }
    chars += JSON.stringify(part).length;
  }
  return chars;
}

function serializeCompactMessage(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  return [`[${message.role}]`, serializeCompactContent(content)].join('\n');
}

function serializeCompactContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? '');
  }
  return content.map(serializeCompactPart).join('\n');
}

function serializeCompactPart(part: unknown): string {
  if (typeof part !== 'object' || part === null) {
    return String(part ?? '');
  }
  const record = part as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'part';
  if (type === 'text') {
    return readPartText(record);
  }
  if (type === 'tool-call') {
    const name = readPartString(record, 'toolName') ?? 'unknown';
    const input = record['input'] ?? record['args'] ?? {};
    return `[Assistant tool call: ${name}]\n${JSON.stringify(input)}`;
  }
  if (type === 'tool-result') {
    const name = readPartString(record, 'toolName') ?? 'unknown';
    return `[Tool result: ${name}]\n${serializeToolResult(record)}`;
  }
  if (type === 'image' || type === 'file') {
    return `[${type} attachment omitted]`;
  }
  return `[${type}]\n${JSON.stringify(record)}`;
}

function serializeToolResult(record: Record<string, unknown>): string {
  const output = record['output'] ?? record['result'] ?? record['content'];
  if (typeof output === 'string') {
    return output;
  }
  if (typeof output !== 'object' || output === null) {
    return String(output ?? '');
  }
  const result = output as { output?: unknown; metadata?: unknown };
  const text = typeof result.output === 'string' ? result.output : '';
  const metadata =
    typeof result.metadata === 'object' && result.metadata !== null
      ? summarizeToolMetadata(result.metadata as Record<string, unknown>)
      : '';
  return [text, metadata].filter((part) => part !== '').join('\n');
}

function summarizeToolMetadata(metadata: Record<string, unknown>): string {
  const changes = metadata['fileChanges'];
  if (!Array.isArray(changes)) {
    return '';
  }
  const paths = changes
    .map((change) =>
      typeof change === 'object' &&
      change !== null &&
      typeof (change as { path?: unknown }).path === 'string'
        ? (change as { path: string }).path
        : undefined,
    )
    .filter((path): path is string => path !== undefined);
  return paths.length > 0
    ? `[modified files]\n${[...new Set(paths)].join('\n')}`
    : '';
}

function readPartText(record: Record<string, unknown>): string {
  const value = record['text'] ?? record['content'];
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function readPartString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** 判断一个 part 是否是 tool-call，并归一化出 toolName / 入参字段。 */
function isToolCallPart(
  part: unknown,
): part is { type: string; toolName: string; input?: unknown; args?: unknown } {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: string }).type === 'tool-call' &&
    typeof (part as { toolName?: unknown }).toolName === 'string'
  );
}
