/**
 * Composer 自动补全：触发器识别 + 候选排序。
 *
 * 触发器：`/` 命令、`@` 文件/引用、`#` task/session mention。排序遵循
 * exact prefix > frecency > fuzzy > path depth，最近选过的项加权。逻辑全为纯函数，
 * 真正的文件/命令清单由 App 注入，便于单测排序行为。
 */
export type TriggerKind = 'command' | 'file' | 'mention' | 'skill';

export interface Trigger {
  readonly kind: TriggerKind;
  /** 触发符之后、光标之前的查询串。 */
  readonly query: string;
  /** 触发符在该行中的列号（含触发符本身）。 */
  readonly tokenStart: number;
}

/**
 * 从「光标所在行、光标之前的文本」识别触发器。
 * - `/` 仅当整行以 `/` 开头时视为命令补全。
 * - `@` / `#` 取最近一个、且前面是行首或空白、后面无空白的 token。
 */
export function detectTrigger(lineBeforeCursor: string): Trigger | undefined {
  if (lineBeforeCursor.startsWith('/') && !lineBeforeCursor.includes(' ')) {
    return { kind: 'command', query: lineBeforeCursor.slice(1), tokenStart: 0 };
  }
  const at = lastTokenStart(lineBeforeCursor, '@');
  const hash = lastTokenStart(lineBeforeCursor, '#');
  const dollar = lastTokenStart(lineBeforeCursor, '$');
  const start = Math.max(at, hash, dollar);
  if (start < 0) {
    return undefined;
  }
  const symbol = lineBeforeCursor[start];
  const query = lineBeforeCursor.slice(start + 1);
  if (/\s/u.test(query)) {
    return undefined;
  }
  return {
    kind: symbol === '@' ? 'file' : symbol === '#' ? 'mention' : 'skill',
    query,
    tokenStart: start,
  };
}

function lastTokenStart(text: string, symbol: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === symbol) {
      const prev = index === 0 ? undefined : text[index - 1];
      return prev === undefined || /\s/u.test(prev) ? index : -1;
    }
    if (char !== undefined && /\s/u.test(char)) {
      return -1;
    }
  }
  return -1;
}

function isSubsequence(query: string, candidate: string): boolean {
  let qi = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci += 1) {
    if (candidate[ci] === query[qi]) {
      qi += 1;
    }
  }
  return qi === query.length;
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

const NO_MATCH = Number.NEGATIVE_INFINITY;

/** 单个候选的匹配分；越大越靠前，无匹配返回 -Infinity。 */
export function scoreCandidate(
  query: string,
  candidate: string,
  frecency = 0,
): number {
  if (query === '') {
    return 100 + frecency - depthOf(candidate);
  }
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let base: number;
  if (c === q) {
    base = 1000;
  } else if (c.startsWith(q)) {
    base = 700;
  } else if (basename(c).startsWith(q)) {
    base = 600;
  } else if (c.includes(q)) {
    base = 400;
  } else if (isSubsequence(q, c)) {
    base = 200;
  } else {
    return NO_MATCH;
  }
  return base + frecency - depthOf(candidate);
}

function depthOf(path: string): number {
  let depth = 0;
  for (const char of path) {
    if (char === '/') {
      depth += 1;
    }
  }
  return depth * 2;
}

export interface RankOptions {
  readonly frecency?: ReadonlyMap<string, number>;
  readonly limit?: number;
}

/** 按查询给候选打分并排序，过滤掉不匹配项。 */
export function rankCandidates(
  query: string,
  candidates: readonly string[],
  options: RankOptions = {},
): readonly string[] {
  const frecency = options.frecency;
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(query, candidate, frecency?.get(candidate) ?? 0),
    }))
    .filter((entry) => entry.score !== NO_MATCH)
    .sort(
      (a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate),
    );
  const limit = options.limit ?? 10;
  return scored.slice(0, limit).map((entry) => entry.candidate);
}

/**
 * 简单 frecency 记账：最近选过的项分值更高。
 * 这是一个可被 App 持有的不可变累积器；返回新的 Map。
 */
export function bumpFrecency(
  frecency: ReadonlyMap<string, number>,
  key: string,
): ReadonlyMap<string, number> {
  const next = new Map(frecency);
  next.set(key, (next.get(key) ?? 0) + 50);
  // 轻微衰减其它项，避免无限增长主导排序。
  for (const [other, value] of next) {
    if (other !== key && value > 0) {
      next.set(other, value - 1);
    }
  }
  return next;
}
