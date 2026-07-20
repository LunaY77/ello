/**
 * Composer 粘贴截断：占位符生成、匹配与解析。
 *
 * Ink 在终端开启括号粘贴模式时，会把完整粘贴内容一次性传给 useInput。
 * 超过 PASTE_TRUNCATION_THRESHOLD 的单次输入视为粘贴，改为插入形如
 * "[Pasted Content: 1902 chars]" 的占位符，并按序号区分多次粘贴。
 * 提交时通过 resolvePastePlaceholders 还原所有原始文本。
 *
 * 所有函数均为纯函数，不依赖 React，便于单测。
 */

/** 超过此长度的单次输入视为粘贴，插入缩略文本而非全量内容。 */
export const PASTE_TRUNCATION_THRESHOLD = 500;

/**
 * 粘贴占位符匹配模式。
 * 第一组捕获字符数，可选第二组捕获序号（#2, #3, …）。
 * 示例: "[Pasted Content: 1902 chars]" → ["1902", undefined]
 *       "[Pasted Content: 1902 chars] #3" → ["1902", "3"]
 */
export const PASTE_PLACEHOLDER_RE =
  /\[Pasted Content: (\d+) chars\](?: #(\d+))?/;

/**
 * 生成粘贴占位符字符串。
 * pasteId 为 1 时不带序号后缀。
 */
export function formatPastePlaceholder(
  charCount: number,
  pasteId: number,
): string {
  if (pasteId === 1) {
    return `[Pasted Content: ${charCount} chars]`;
  }
  return `[Pasted Content: ${charCount} chars] #${pasteId}`;
}

/**
 * 检查文本末尾是否以粘贴占位符结束。
 * 用于 Backspace 键原子删除整个占位符块。
 */
export function matchPastePlaceholderAtEnd(text: string): {
  id: number;
  length: number;
} | null {
  const m = new RegExp(PASTE_PLACEHOLDER_RE.source + '$').exec(text);
  if (m === null) return null;
  return { id: Number(m[2] ?? '1'), length: m[0].length };
}

/**
 * 检查文本开头是否以粘贴占位符开始。
 * 用于 Delete 键原子删除整个占位符块。
 */
export function matchPastePlaceholderAtStart(text: string): {
  id: number;
  length: number;
} | null {
  const m = new RegExp('^' + PASTE_PLACEHOLDER_RE.source).exec(text);
  if (m === null) return null;
  return { id: Number(m[2] ?? '1'), length: m[0].length };
}

/**
 * 将文本中所有粘贴占位符替换为原始粘贴内容。
 * pastes Map 中的 id 对应占位符序号；找不到对应的占位符保留原文不变。
 */
export function resolvePastePlaceholders(
  text: string,
  pastes: ReadonlyMap<number, string>,
): string {
  let result = '';
  let lastIndex = 0;
  const re = new RegExp(PASTE_PLACEHOLDER_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = Number(m[2] ?? '1');
    const fullText = pastes.get(id) ?? m[0];
    result += text.slice(lastIndex, m.index) + fullText;
    lastIndex = re.lastIndex;
  }
  result += text.slice(lastIndex);
  return result;
}
