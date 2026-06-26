import type { ModelMessage } from 'ai';

type UserMessage = Extract<ModelMessage, { role: 'user' }>;
type UserContent = UserMessage['content'];
type UserContentPart = Exclude<UserContent, string>[number];

/**
 * 历史裁剪选项。
 *
 * Args:
 *   preserveLastTurn: 是否保留最后一个用户 turn 不做注入上下文裁剪。
 *   injectedContextTags: 需要剥离的注入上下文 XML 标签名。
 *   maxToolReturnChars: 工具返回内容的最大字符数。
 *   toolReturnKeepHead: 截断时保留的头部字符数。
 *   toolReturnKeepTail: 截断时保留的尾部字符数。
 *   stripMedia: 是否将媒体内容替换为占位符文本。
 *   stripInjectedContext: 是否剥离注入的上下文 XML。
 */
export interface TrimOptions {
  preserveLastTurn: boolean;
  injectedContextTags: string[];
  maxToolReturnChars: number;
  toolReturnKeepHead: number;
  toolReturnKeepTail: number;
  stripMedia: boolean;
  stripInjectedContext: boolean;
}

/** 历史裁剪结果。 */
export interface TrimResult {
  messages: ModelMessage[];
  originalMessageCount: number;
  trimmedMessageCount: number;
  truncatedToolReturnCount: number;
  strippedMediaCount: number;
  strippedInjectedContextCount: number;
}

/** 默认历史裁剪选项。 */
export function createTrimOptions(
  options: Partial<TrimOptions> = {},
): TrimOptions {
  return {
    preserveLastTurn: false,
    injectedContextTags: ['runtime-context'],
    maxToolReturnChars: 500,
    toolReturnKeepHead: 200,
    toolReturnKeepTail: 200,
    stripMedia: true,
    stripInjectedContext: true,
    ...options,
  };
}

/** 裁剪消息历史, 为摘要或 compact 做准备。 */
export function trimHistory(
  messageHistory: readonly ModelMessage[],
  options: Partial<TrimOptions> = {},
): TrimResult {
  const opts = createTrimOptions(options);
  const messages = [...messageHistory];
  const lastUserTurnIndex = opts.preserveLastTurn
    ? findLastUserTurnIndex(messages)
    : null;

  const trimmed: ModelMessage[] = [];
  let truncatedToolReturnCount = 0;
  let strippedMediaCount = 0;
  let strippedInjectedContextCount = 0;

  messages.forEach((message, index) => {
    if (message.role === 'tool') {
      const { message: newMessage, changed } = trimToolMessage(message, opts);
      if (changed) {
        truncatedToolReturnCount += 1;
      }
      trimmed.push(newMessage);
      return;
    }

    if (message.role !== 'user') {
      trimmed.push(message);
      return;
    }

    const isInLastTurn =
      lastUserTurnIndex !== null && index >= lastUserTurnIndex;
    const userResult = trimUserMessage(message, opts, isInLastTurn);

    strippedMediaCount += userResult.strippedMediaCount;
    strippedInjectedContextCount += userResult.strippedInjectedContextCount;

    if (userResult.message !== null) {
      trimmed.push(userResult.message);
    }
  });

  return {
    messages: trimmed,
    originalMessageCount: messageHistory.length,
    trimmedMessageCount: trimmed.length,
    truncatedToolReturnCount,
    strippedMediaCount,
    strippedInjectedContextCount,
  };
}

function truncateString(content: string, options: TrimOptions): string {
  if (content.length <= options.maxToolReturnChars) {
    return content;
  }
  const head = content.slice(0, options.toolReturnKeepHead);
  const tail = content.slice(-options.toolReturnKeepTail);
  const truncatedCount =
    content.length - options.toolReturnKeepHead - options.toolReturnKeepTail;
  return `${head}\n[... ${truncatedCount} chars truncated ...]\n${tail}`;
}

function findLastUserTurnIndex(messages: ModelMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return i;
    }
  }
  return null;
}

function trimToolMessage(
  message: Extract<ModelMessage, { role: 'tool' }>,
  options: TrimOptions,
): { message: ModelMessage; changed: boolean } {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== 'tool-result') {
      return part;
    }
    const asText = toolResultOutputToString(part.output);
    if (asText.length <= options.maxToolReturnChars) {
      return part;
    }
    changed = true;
    return {
      ...part,
      output: { type: 'text' as const, value: truncateString(asText, options) },
    };
  });

  return { message: { ...message, content }, changed };
}

function trimUserMessage(
  message: UserMessage,
  options: TrimOptions,
  isInLastTurn: boolean,
): {
  message: ModelMessage | null;
  strippedMediaCount: number;
  strippedInjectedContextCount: number;
} {
  let strippedMediaCount = 0;
  let strippedInjectedContextCount = 0;
  let content: UserContent = message.content;

  if (options.stripMedia) {
    const result = stripMediaFromUserContent(content);
    content = result.content;
    strippedMediaCount += result.changed ? 1 : 0;
  }

  if (options.stripInjectedContext && !isInLastTurn) {
    const result = stripInjectedContextFromUserContent(
      content,
      options.injectedContextTags,
    );
    if (result.changed) {
      strippedInjectedContextCount += 1;
    }
    if (result.content === null) {
      return {
        message: null,
        strippedMediaCount,
        strippedInjectedContextCount,
      };
    }
    content = result.content;
  }

  return {
    message: { ...message, content } as ModelMessage,
    strippedMediaCount,
    strippedInjectedContextCount,
  };
}

function stripMediaFromUserContent(content: UserContent): {
  content: UserContent;
  changed: boolean;
} {
  if (!Array.isArray(content)) {
    return { content, changed: false };
  }

  let changed = false;
  const replaced = content.map((part) => {
    if (isMediaPart(part)) {
      changed = true;
      return {
        type: 'text' as const,
        text: mediaPlaceholder(part),
      };
    }
    return part;
  });

  return { content: replaced as UserContentPart[], changed };
}

function stripInjectedContextFromUserContent(
  content: UserContent,
  tags: string[],
): { content: UserContent | null; changed: boolean } {
  if (typeof content === 'string') {
    const { text, changed } = stripInjectedContextText(content, tags);
    return { content: text, changed };
  }

  const prefixes = tags.map((tag) => `<${tag}`);
  const filtered = content.filter((part) => {
    if (part.type !== 'text') {
      return true;
    }
    return !prefixes.some((prefix) => part.text.trimStart().startsWith(prefix));
  });

  if (filtered.length === 0) {
    return { content: null, changed: filtered.length !== content.length };
  }
  return {
    content: filtered,
    changed: filtered.length !== content.length,
  };
}

function stripInjectedContextText(
  content: string,
  tags: string[],
): { text: string | null; changed: boolean } {
  const tagRegex = buildTagRegex(tags);
  const cleaned = (tagRegex ? content.replace(tagRegex, '') : content).trim();
  if (cleaned.length === 0) {
    return { text: null, changed: cleaned !== content };
  }
  if (cleaned !== content.trim()) {
    return { text: cleaned, changed: true };
  }
  return { text: content, changed: false };
}

function buildTagRegex(tags: string[]): RegExp | null {
  if (tags.length === 0) {
    return null;
  }
  const alternatives = tags.map(escapeRegex).join('|');
  return new RegExp(`<(${alternatives})(?:\\s[^>]*)?>.*?</\\1>`, 'gs');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMediaPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) {
    return false;
  }
  const typed = part as { type?: string; mediaType?: string };
  if (typed.type === 'image') {
    return true;
  }
  return (
    typed.type === 'file' &&
    (typed.mediaType?.startsWith('image/') === true ||
      typed.mediaType?.startsWith('video/') === true)
  );
}

function mediaPlaceholder(part: unknown): string {
  if (typeof part !== 'object' || part === null) {
    return '[media content removed]';
  }
  const typed = part as {
    type?: string;
    image?: unknown;
    data?: unknown;
    mediaType?: string;
  };
  if (typed.type === 'image') {
    return `[image: ${mediaDataToString(typed.image)}]`;
  }
  if (typed.mediaType?.startsWith('video/')) {
    return `[video: ${mediaDataToString(typed.data)}]`;
  }
  if (typed.mediaType) {
    return `[${typed.mediaType} binary content removed]`;
  }
  return '[media content removed]';
}

function mediaDataToString(value: unknown): string {
  if (value instanceof URL) {
    return value.toString();
  }
  if (typeof value === 'object' && value !== null && 'url' in value) {
    return String((value as { url: unknown }).url);
  }
  return '[inline]';
}

function toolResultOutputToString(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (typeof output !== 'object' || output === null) {
    return String(output ?? '');
  }
  const typed = output as { value?: unknown; reason?: unknown };
  if (typeof typed.value === 'string') {
    return typed.value;
  }
  if (typed.value !== undefined) {
    return JSON.stringify(typed.value);
  }
  if (typeof typed.reason === 'string') {
    return typed.reason;
  }
  return JSON.stringify(output);
}
