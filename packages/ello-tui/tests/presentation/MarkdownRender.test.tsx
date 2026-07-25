import { render } from 'ink-testing-library';
import { Lexer } from 'marked';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { resolveTheme } from '../../src/tui/theme/themes.js';
import type { TuiTheme } from '../../src/tui/theme/types.js';
import { highlightCode } from '../../src/tui/utils/markdown/highlight.js';
import { renderMarkdown } from '../../src/tui/utils/markdown/render.js';

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
    expect(out).toContain('\x1b[38;2;187;154;247mconst');
    expect(out).toContain('\x1b[38;2;125;207;255m x = ');
    expect(out).toContain('\x1b[38;2;158;206;106m"hi"');
  });

  it('未知语言不抛错，并回退到 markdownCode 的 ANSI truecolor', () => {
    const code = 'plain code';
    const expected = '\x1b[38;2;125;207;255mplain code\x1b[39m';

    expect(() =>
      highlightCode(code, 'not-a-real-language', theme),
    ).not.toThrow();
    expect(highlightCode(code, 'not-a-real-language', theme)).toBe(expected);
  });

  it('空代码块返回空字符串', () => {
    expect(highlightCode('', 'ts', theme)).toBe('');
  });
});
function renderText(node: ReactNode): string {
  return render(<>{node}</>).lastFrame() ?? '';
}

describe('renderMarkdown 节点映射', () => {
  it('heading 渲染为加粗文本且不含 #', () => {
    const frame = renderText(renderMarkdown('# Title', theme));
    expect(frame).not.toContain('# Title');
    expect(frame).toContain('Title');
  });

  it('paragraph 渲染正文', () => {
    expect(renderText(renderMarkdown('hello world', theme))).toContain(
      'hello world',
    );
  });

  it('ordered list 渲染序号', () => {
    const frame = renderText(renderMarkdown('1. one\n2. two', theme));
    expect(frame).toContain('1. one');
    expect(frame).toContain('2. two');
  });

  it('unordered list 渲染 bullet', () => {
    const frame = renderText(renderMarkdown('- a\n- b', theme));
    expect(frame).toContain('- a');
    expect(frame).toContain('- b');
  });

  it('nested list 使用每层两个字符的缩进', () => {
    const frame = renderText(
      renderMarkdown('- parent\n  - child\n    - grandchild', theme),
    );
    expect(frame).toContain('- parent\n  - child\n    - grandchild');
  });

  it('codespan 渲染内容', () => {
    const frame = renderText(renderMarkdown('use `inline` code', theme));
    expect(frame).toContain('inline');
  });

  it('strong 渲染内容', () => {
    const frame = renderText(renderMarkdown('**bold** text', theme));
    expect(frame).toContain('bold');
  });

  it('em、link 与删除线渲染其文本内容', () => {
    const frame = renderText(
      renderMarkdown('*em* [link](https://example.com) ~~deleted~~', theme),
    );
    expect(frame).toContain('em');
    expect(frame).toContain('link');
    expect(frame).toContain('deleted');
    expect(frame).not.toContain('https://example.com');
  });

  it('代码块渲染内容', () => {
    const md = '```ts\nconst x = 1;\n```';
    expect(renderText(renderMarkdown(md, theme))).toMatch(
      /const[\s\S]*x = 1/su,
    );
  });

  it('无语言代码块渲染内容', () => {
    const md = '```\nplain code\n```';
    expect(renderText(renderMarkdown(md, theme))).toContain('plain code');
  });

  it('blockquote 渲染前缀 >', () => {
    const frame = renderText(renderMarkdown('> quoted line', theme));
    expect(frame).toContain('> quoted line');
  });

  it('hr 渲染分隔线', () => {
    expect(renderText(renderMarkdown('---', theme))).toContain('─');
  });
});

describe('renderMarkdown 流式容错', () => {
  it('streaming 下未闭合 fence 不崩', () => {
    const frame = renderText(
      renderMarkdown('# h\n\n```ts\nconst', theme, { streaming: true }),
    );
    expect(frame).toContain('const');
  });
});

describe('renderMarkdown 降级', () => {
  it('Lexer 抛错时回退到纯文本', () => {
    const lex = vi.spyOn(Lexer, 'lex').mockImplementationOnce(() => {
      throw new Error('synthetic parse failure');
    });
    expect(renderText(renderMarkdown('just text', theme))).toContain(
      'just text',
    );
    lex.mockRestore();
  });

  it('空字符串渲染为空', () => {
    expect(renderText(renderMarkdown('', theme))).toBe('');
  });
});
