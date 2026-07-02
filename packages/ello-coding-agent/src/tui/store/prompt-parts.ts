/**
 * 结构化 prompt parts。
 *
 * Composer 提交的不再是「把文件内容直接拼进去的字符串」，而是有序的 parts。
 * runtime 在提交前把 parts 转成模型消息：文本原样保留，file part 按需读取内容
 * （可带行区间）。这样 @file 的展开点单一、可测、可被 provider capability 改写。
 */
export type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'file';
      readonly path: string;
      readonly lineStart?: number;
      readonly lineEnd?: number;
    }
  | { readonly type: 'agent'; readonly name: string }
  | { readonly type: 'skill'; readonly name: string }
  | {
      readonly type: 'mcp-resource';
      readonly server: string;
      readonly uri: string;
    };

const MENTION_RE = /@([^\s#@]+)(?:#(\d+)(?:-(\d+))?)?/gu;

/** 把 composer 文本解析成有序 parts。仅识别 `@path` / `@path#10` / `@path#10-30`。 */
export function parsePromptParts(text: string): readonly PromptPart[] {
  const parts: PromptPart[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const index = match.index ?? 0;
    const before = text[index - 1];
    // 仅当 @ 处于词首（行首或空白后）才视为 mention，避免误吃 email 等。
    if (before !== undefined && !/\s/u.test(before)) {
      continue;
    }
    if (index > lastIndex) {
      parts.push({ type: 'text', text: text.slice(lastIndex, index) });
    }
    const path = match[1] ?? '';
    const start = match[2];
    const end = match[3];
    parts.push({
      type: 'file',
      path,
      ...(start !== undefined ? { lineStart: Number(start) } : {}),
      ...(end !== undefined
        ? { lineEnd: Number(end) }
        : start !== undefined
          ? { lineEnd: Number(start) }
          : {}),
    });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.slice(lastIndex) });
  }
  if (parts.length === 0) {
    return [{ type: 'text', text }];
  }
  return parts;
}

export function hasFileParts(parts: readonly PromptPart[]): boolean {
  return parts.some((part) => part.type === 'file');
}

/** 拼回纯文本（用于 transcript 即时回显与历史）。 */
export function partsToDisplayText(parts: readonly PromptPart[]): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'file': {
          const range =
            part.lineStart !== undefined
              ? `#${part.lineStart}${
                  part.lineEnd !== undefined && part.lineEnd !== part.lineStart
                    ? `-${part.lineEnd}`
                    : ''
                }`
              : '';
          return `@${part.path}${range}`;
        }
        case 'agent':
          return `@${part.name}`;
        case 'skill':
          return `@${part.name}`;
        case 'mcp-resource':
          return `@${part.server}:${part.uri}`;
      }
    })
    .join('');
}

export interface SerializeOptions {
  readonly cwd: string;
  readFile(absolutePath: string): Promise<string>;
  resolvePath(cwd: string, relative: string): string;
}

function sliceLines(content: string, start?: number, end?: number): string {
  if (start === undefined) {
    return content;
  }
  const lines = content.split('\n');
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end ?? start);
  return lines.slice(from - 1, to).join('\n');
}

/**
 * 把 parts 转成最终模型输入文本。
 *
 * file part 会被读取并包进 `<attached-file>`，可带行区间。`readFile`/`resolvePath`
 * 通过参数注入，使本函数在单测中无需触碰真实文件系统。
 */
export async function serializeForModel(
  parts: readonly PromptPart[],
  options: SerializeOptions,
): Promise<string> {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      chunks.push(part.text);
      continue;
    }
    if (part.type === 'file') {
      const absolute = options.resolvePath(options.cwd, part.path);
      const content = await options.readFile(absolute);
      const sliced = sliceLines(content, part.lineStart, part.lineEnd);
      const range =
        part.lineStart !== undefined
          ? ` lines="${part.lineStart}-${part.lineEnd ?? part.lineStart}"`
          : '';
      chunks.push(
        `\n<attached-file path="${part.path}"${range}>\n${sliced}\n</attached-file>\n`,
      );
      continue;
    }
    if (part.type === 'agent') {
      chunks.push(`@agent:${part.name}`);
      continue;
    }
    if (part.type === 'skill') {
      chunks.push(`@skill:${part.name}`);
      continue;
    }
    chunks.push(`@mcp:${part.server}:${part.uri}`);
  }
  return chunks.join('');
}
