import { describe, expect, it } from 'vitest';

import {
  formatPastePlaceholder,
  matchPastePlaceholderAtEnd,
  matchPastePlaceholderAtStart,
  PASTE_PLACEHOLDER_RE,
  PASTE_TRUNCATION_THRESHOLD,
  resolvePastePlaceholders,
} from '../../src/tui/store/composer-paste.js';

describe('粘贴截断阈值', () => {
  it('将超过 500 字符的单次输入判定为粘贴', () => {
    expect(PASTE_TRUNCATION_THRESHOLD).toBe(500);
  });
});

describe('粘贴占位符格式', () => {
  it('首次粘贴不带序号后缀', () => {
    expect(formatPastePlaceholder(1902, 1)).toBe(
      '[Pasted Content: 1902 chars]',
    );
  });

  it('第二次及后续粘贴带 #N 序号', () => {
    expect(formatPastePlaceholder(5000, 2)).toBe(
      '[Pasted Content: 5000 chars] #2',
    );
    expect(formatPastePlaceholder(1024, 7)).toBe(
      '[Pasted Content: 1024 chars] #7',
    );
  });
});

describe('PASTE_PLACEHOLDER_RE', () => {
  it('匹配不带序号的占位符', () => {
    const m = PASTE_PLACEHOLDER_RE.exec('[Pasted Content: 1902 chars]');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('1902');
    expect(m![2]).toBeUndefined();
  });

  it('匹配带序号的占位符', () => {
    const m = PASTE_PLACEHOLDER_RE.exec('[Pasted Content: 5000 chars] #3');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('5000');
    expect(m![2]).toBe('3');
  });

  it('不匹配带有错误格式的文本', () => {
    expect(PASTE_PLACEHOLDER_RE.test('[Pasted Content: chars]')).toBe(false);
    expect(PASTE_PLACEHOLDER_RE.test('just some text')).toBe(false);
  });
});

describe('matchPastePlaceholderAtEnd', () => {
  it('匹配行尾的不带序号占位符', () => {
    const result = matchPastePlaceholderAtEnd(
      'before [Pasted Content: 1902 chars]',
    );
    expect(result).toEqual({ id: 1, length: 28 });
  });

  it('匹配行尾的带序号占位符', () => {
    const result = matchPastePlaceholderAtEnd(
      'hello [Pasted Content: 5000 chars] #3',
    );
    expect(result).toEqual({ id: 3, length: 31 });
  });

  it('只在末尾匹配，文本中间的占位符不算', () => {
    const result = matchPastePlaceholderAtEnd(
      '[Pasted Content: 500 chars] middle',
    );
    expect(result).toBeNull();
  });

  it('无占位符时返回 null', () => {
    expect(matchPastePlaceholderAtEnd('plain text')).toBeNull();
    expect(matchPastePlaceholderAtEnd('')).toBeNull();
  });
});

describe('matchPastePlaceholderAtStart', () => {
  it('匹配行首的不带序号占位符', () => {
    const result = matchPastePlaceholderAtStart(
      '[Pasted Content: 1024 chars] after',
    );
    expect(result).toEqual({ id: 1, length: 28 });
  });

  it('匹配行首的带序号占位符', () => {
    const result = matchPastePlaceholderAtStart(
      '[Pasted Content: 5000 chars] #4 rest',
    );
    expect(result).toEqual({ id: 4, length: 31 });
  });

  it('只匹配行首，中间的占位符不算', () => {
    const result = matchPastePlaceholderAtStart(
      'prefix [Pasted Content: 500 chars]',
    );
    expect(result).toBeNull();
  });

  it('无占位符时返回 null', () => {
    expect(matchPastePlaceholderAtStart('plain text')).toBeNull();
    expect(matchPastePlaceholderAtStart('')).toBeNull();
  });
});

describe('resolvePastePlaceholders', () => {
  it('替换单个占位符', () => {
    const pastes = new Map([[1, 'A'.repeat(2000)]]);
    expect(
      resolvePastePlaceholders(
        'hello [Pasted Content: 2000 chars] world',
        pastes,
      ),
    ).toBe(`hello ${'A'.repeat(2000)} world`);
  });

  it('替换多个不同序号的占位符', () => {
    const pastes = new Map([
      [1, 'FIRST'],
      [2, 'SECOND'],
      [3, 'THIRD'],
    ]);
    expect(
      resolvePastePlaceholders(
        '[Pasted Content: 5 chars] [Pasted Content: 6 chars] #2 [Pasted Content: 5 chars] #3',
        pastes,
      ),
    ).toBe('FIRST SECOND THIRD');
  });

  it('Map 中缺少对应 id 时保留占位符原文', () => {
    const pastes = new Map([[1, 'FIRST']]);
    expect(
      resolvePastePlaceholders(
        '[Pasted Content: 5 chars] [Pasted Content: 5 chars] #2',
        pastes,
      ),
    ).toBe('FIRST [Pasted Content: 5 chars] #2');
  });

  it('无占位符时原样返回', () => {
    const pastes = new Map([[1, 'ignored']]);
    expect(resolvePastePlaceholders('plain text', pastes)).toBe('plain text');
  });

  it('空 Map 原样返回', () => {
    expect(
      resolvePastePlaceholders(
        '[Pasted Content: 500 chars]',
        new Map(),
      ),
    ).toBe('[Pasted Content: 500 chars]');
  });
});
