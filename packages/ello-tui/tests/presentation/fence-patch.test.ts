import { describe, expect, it } from 'vitest';

import { patchStreamingMarkdown } from '../../src/tui/utils/markdown/fence-patch.js';

describe('patchStreamingMarkdown', () => {
  it('完整文本原样返回', () => {
    expect(patchStreamingMarkdown('# hello\n')).toBe('# hello\n');
    expect(patchStreamingMarkdown('plain text')).toBe('plain text');
  });

  it('未闭合的代码块补上闭合fence', () => {
    const result = patchStreamingMarkdown('# title\n\n```ts\nconst x = 1;');
    expect(result).toBe('# title\n\n```ts\nconst x = 1;\n```');
  });

  it('已闭合的代码块不重复补', () => {
    const input = '```ts\nconst x = 1;\n```';
    expect(patchStreamingMarkdown(input)).toBe(input);
  });

  it('奇数反引号的inline code补一个反引号', () => {
    expect(patchStreamingMarkdown('use `code here')).toBe('use `code here`');
    expect(patchStreamingMarkdown('a `b` and `c')).toBe('a `b` and `c`');
  });

  it('空字符串原样返回', () => {
    expect(patchStreamingMarkdown('')).toBe('');
  });
});
