import type {
  AgentMessage,
  SessionCompactor,
  SessionCompactionReport,
  SessionStore,
} from '@ello/agent';

/**
 * 长会话上下文压缩器。
 *
 * 比内核自带的 `createSummarySessionCompactor`（仅 `messages.join` 截断 4000
 * 字符）成熟得多，专为长时间 coding 会话设计：
 * - token 估算：遍历消息 part，按 `ceil(chars/4)` 启发式累加；
 * - 触发判定：`tokens > contextWindow - reserveTokens`；
 * - 选切点：从尾部保留 `keepRecentTokens`，再吸附到合法回合边界，
 *   绝不切在 tool-result 前（避免产生孤儿 result）；
 * - 生成摘要：固定结构化模板（Goal/Constraints/Progress/...），支持迭代更新；
 * - 文件清单：抽取被压缩消息里的 read/write/edit 路径，作为 `<read-files>` /
 *   `<modified-files>` 追加到摘要尾部，跨多次压缩累计携带；
 * - 落盘：摘要作为一条 `role:'user'` 的 `<session-summary>` 消息置顶，
 *   通过 `store.replace` 改写持久化历史（与仅影响当轮的裁剪不同）。
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
}

/** 默认压缩配置。 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

/** 序列化对话喂给摘要模型时，单条 tool-result 的截断上限。 */
const TOOL_RESULT_MAX_CHARS = 2000;

/** 摘要模型的系统提示词：强约束“只产出摘要、不要续写对话”。 */
export const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a summarization engine for a coding agent. Output ONLY a structured ' +
  'summary of the conversation so far. Do NOT continue the conversation, answer ' +
  'questions, or call tools. Preserve every fact needed to resume the work.';

/** 首次压缩的摘要模板。 */
export const SUMMARIZATION_PROMPT =
  'Summarize the conversation below into the following sections, preserving all ' +
  'load-bearing detail:\n' +
  '## Goal\n## Constraints & Preferences\n' +
  '## Progress (Done | In Progress | Blocked)\n' +
  '## Key Decisions\n## Next Steps\n## Critical Context\n';

/** 迭代更新的摘要模板：保留旧信息，推进进度。 */
export const UPDATE_SUMMARIZATION_PROMPT =
  'A previous summary is provided in <previous-summary>. Produce an UPDATED ' +
  'summary using the same section structure: keep all still-relevant information, ' +
  'move finished "In Progress" items to "Done", and incorporate the new messages.\n';

/** `summarize` 回调的选项。 */
export interface SummarizeOptions {
  /** 上一次压缩的摘要正文（存在则走迭代更新模板）。 */
  readonly previousSummary?: string;
  /** 本次摘要的 token 上限建议（调用方据此设置 max output）。 */
  readonly maxTokens?: number;
}

/**
 * 摘要生成回调：由会话装配处注入，内部走一次性模型补全生成摘要文本。
 * 压缩器本身不持有模型适配器，以此保持与具体 provider 解耦。
 */
export type Summarize = (
  messages: readonly AgentMessage[],
  opts: SummarizeOptions,
) => Promise<string>;

/** {@link createSessionCompactor} 的依赖。 */
export interface SessionCompactorDeps {
  /** 模型上下文窗口（token），用于触发判定。 */
  readonly contextWindow: number;
  /** 摘要生成回调。 */
  readonly summarize: Summarize;
  /** 覆盖默认压缩配置。 */
  readonly settings?: Partial<CompactionSettings>;
  /** 读取上一次摘要（用于迭代更新；缺省视为首次压缩）。 */
  readonly previousSummary?: () => string | null | Promise<string | null>;
}

/** 估算单条消息的 token 数（`ceil(chars/4)` 启发式，遍历 part）。 */
export function estimateTokens(message: AgentMessage): number {
  const { content } = message as { content: unknown };
  const chars =
    typeof content === 'string' ? content.length : measureParts(content);
  return Math.ceil(chars / 4);
}

/** 估算整个历史的 token 总数。 */
export function estimateContextTokens(messages: readonly AgentMessage[]): {
  readonly tokens: number;
} {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateTokens(message);
  }
  return { tokens };
}

/** 触发判定：已用 token 超过「窗口 - 预留」即需要压缩。 */
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
 * 选切点：从尾部累加保留 `keepRecentTokens`，再吸附到合法回合边界。
 *
 * 返回切点下标 `cut`：`[0, cut)` 进摘要，`[cut, end)` 保留。
 * - 优先吸附到最近的 `user` 消息边界（整回合保留，避免切碎回合）；
 * - 否则退回到最近的非 `tool` 边界（避免孤儿 tool-result）；
 * - 无可压缩内容（cut <= 0）时返回 null。
 */
export function findCutPoint(
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
): number | null {
  if (messages.length === 0) {
    return null;
  }
  // 从尾部往回累加，直到攒够 keepRecentTokens，得到 token 维度的初始切点。
  let acc = 0;
  let tokenCut = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    acc += estimateTokens(messages[i]!);
    tokenCut = i;
    if (acc >= keepRecentTokens) {
      break;
    }
  }

  // 优先吸附到 <= tokenCut 的最近 user 边界（整回合保留）。
  for (let i = tokenCut; i > 0; i -= 1) {
    if (messages[i]!.role === 'user') {
      return i;
    }
  }
  // 退回到 <= tokenCut 的最近非 tool 边界（避免孤儿 tool-result）。
  for (let i = tokenCut; i > 0; i -= 1) {
    if (messages[i]!.role !== 'tool') {
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

/** 把文件清单以 `<read-files>` / `<modified-files>` 标签追加到摘要尾部。 */
export function appendFileManifest(
  summary: string,
  files: { readonly readFiles: string[]; readonly modifiedFiles: string[] },
): string {
  const parts = [summary.trim()];
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

/** 把摘要正文包成一条置顶的 `role:'user'` `<session-summary>` 消息。 */
export function summaryMessage(summary: string): AgentMessage {
  return {
    role: 'user',
    content: `<session-summary>\n${summary}\n</session-summary>`,
  } as AgentMessage;
}

/** 序列化历史喂给摘要模型：tool-result 截断到 TOOL_RESULT_MAX_CHARS。 */
export function serializeForSummary(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    const text =
      typeof content === 'string' ? content : JSON.stringify(content);
    return {
      ...message,
      content: text.slice(0, TOOL_RESULT_MAX_CHARS),
    } as unknown as AgentMessage;
  });
}

/**
 * 构造长会话压缩器 {@link SessionCompactor}，替换内核的简陋默认实现。
 *
 * 触发流程（`maybeCompact`）：
 * 1. `store.load` 取当前主分支线性历史；
 * 2. 估算 token，未超阈值则返回 null（不压缩）；
 * 3. 选切点，无可压缩内容则返回 null；
 * 4. 调 `summarize` 生成结构化摘要，追加文件清单；
 * 5. `store.replace` 用 `[摘要消息, ...保留消息]` 改写历史。
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
      store: SessionStore,
    ): Promise<SessionCompactionReport | null> {
      if (store.replace === undefined) {
        return null;
      }
      const messages = await store.load(sessionId);
      const { tokens } = estimateContextTokens(messages);
      if (!shouldCompact(tokens, deps.contextWindow, settings)) {
        return null;
      }

      const cut = findCutPoint(messages, settings.keepRecentTokens);
      if (cut === null) {
        return null;
      }
      const toSummarize = messages.slice(0, cut);
      const kept = messages.slice(cut);
      if (toSummarize.length === 0) {
        return null;
      }

      const previousSummary = (await deps.previousSummary?.()) ?? undefined;
      const raw = await deps.summarize(serializeForSummary(toSummarize), {
        ...(previousSummary !== undefined ? { previousSummary } : {}),
        maxTokens: Math.floor(settings.reserveTokens * 0.8),
      });
      const summary = appendFileManifest(raw, extractFileOps(toSummarize));

      const next: AgentMessage[] = [summaryMessage(summary), ...kept];
      await store.replace(sessionId, next, {
        compactor: 'ello-session-compactor',
        summary,
      });

      return {
        compactor: 'ello-session-compactor',
        beforeMessageCount: messages.length,
        afterMessageCount: next.length,
        metadata: { tokensBefore: tokens, cutIndex: cut },
      };
    },
  };
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
