import { describe, expect, it } from 'vitest';

import type { TuiTheme } from '../../src/tui/theme/types.js';
import { resolveTheme } from '../../src/tui/theme/themes.js';
import { highlightCode } from '../../src/tui/utils/markdown/highlight.js';

const theme: TuiTheme = resolveTheme('tokyo-night');

describe('highlightCode', () => {
  it('无语言标签时整块单色，含 ANSI 前景转义', () => {
    const out = highlightCode('const x = 1;', undefined, theme);
    expect(out).toContain('const x = 1;');
    // 无语言走手写 ANSI 着色，包含 markdownCode 对应的 truecolor 序列
    expect(out).toContain('\x1b[38;2;');
  });

  it('有语言标签时调用 cli-highlight，产出 ANSI 转义', () => {
    const out = highlightCode('const x = "hi";', 'ts', theme);
    // cli-highlight 产出含 ESC 序列
    expect(out).toContain('\x1b[');
    expect(out).toContain('const');
  });

  it('空代码块返回空字符串', () => {
    expect(highlightCode('', 'ts', theme)).toBe('');
  });
});
