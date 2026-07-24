import { highlight, type Theme } from 'cli-highlight';

import type { TuiTheme } from '../../theme/types.js';

/**
 * 代码块语法高亮。
 *
 * 把 cli-highlight 的 token scope 映射到 ello theme token：
 * keyword / built_in / type / literal → syntaxKeyword
 * string / subst / regexp → syntaxString
 * 其余 scope 回退 cli-highlight DEFAULT_THEME。
 * 返回带 ANSI 转义的字符串，可直接喂给 Ink <Text>。
 */
export function highlightCode(
  code: string,
  language: string | undefined,
  theme: TuiTheme,
): string {
  if (code === '') return '';
  const keywordColor = hexToAnsi(theme.syntaxKeyword);
  const stringColor = hexToAnsi(theme.syntaxString);
  if (language === undefined || language === '') {
    return code
      .split('\n')
      .map((line) => colorize(line, hexToAnsi(theme.markdownCode)))
      .join('\n');
  }
  try {
    return highlight(code, {
      language,
      theme: buildCliHighlightTheme(keywordColor, stringColor),
    });
  } catch {
    return code
      .split('\n')
      .map((line) => colorize(line, hexToAnsi(theme.markdownCode)))
      .join('\n');
  }
}

/** 把 ello theme token 映射为 cli-highlight 的 Theme（scope → 着色函数）。 */
function buildCliHighlightTheme(keywordColor: string, stringColor: string): Theme {
  return {
    keyword: (s) => colorize(s, keywordColor),
    built_in: (s) => colorize(s, keywordColor),
    type: (s) => colorize(s, keywordColor),
    literal: (s) => colorize(s, keywordColor),
    string: (s) => colorize(s, stringColor),
    subst: (s) => colorize(s, stringColor),
    regexp: (s) => colorize(s, stringColor),
  };
}

/** 用 ANSI truecolor 包裹文本。ansi 形如 "r;g;b"。 */
function colorize(text: string, ansi: string): string {
  return `\x1b[38;2;${ansi}m${text}\x1b[39m`;
}

/** #rrggbb → "r;g;b"（用于 ANSI truecolor）。 */
function hexToAnsi(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r};${g};${b}`;
}
