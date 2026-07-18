import { describe, expect, it } from 'vitest';

import {
  bumpFrecency,
  detectTrigger,
  rankCandidates,
  scoreCandidate,
} from '../../src/tui/store/autocomplete.js';

describe('自动补全触发器', () => {
  it('仅把行首且未带参数的斜杠文本识别为命令', () => {
    expect(detectTrigger('/the')).toEqual({
      kind: 'command',
      query: 'the',
      tokenStart: 0,
    });
    expect(detectTrigger('/theme arg')).toBeUndefined();
    expect(detectTrigger('run /theme')).toBeUndefined();
  });

  it('在词元边界识别文件、引用和技能触发器', () => {
    expect(detectTrigger('look at @src/a')).toMatchObject({
      kind: 'file',
      query: 'src/a',
      tokenStart: 8,
    });
    expect(detectTrigger('ping #task')).toMatchObject({
      kind: 'mention',
      query: 'task',
    });
    expect(detectTrigger('use $workspace')).toMatchObject({
      kind: 'skill',
      query: 'workspace',
    });
  });

  it('不会把邮箱和单词中的特殊字符误识别为触发器', () => {
    expect(detectTrigger('mail me@host')).toBeUndefined();
    expect(detectTrigger('price$100')).toBeUndefined();
    expect(detectTrigger('issue#123')).toBeUndefined();
  });
});

describe('自动补全候选排序', () => {
  it('按精确、前缀、文件名、子串和子序列的优先级排序', () => {
    expect(scoreCandidate('read', 'read')).toBeGreaterThan(
      scoreCandidate('read', 'reader'),
    );
    expect(scoreCandidate('read', 'src/read-file.ts')).toBeGreaterThan(
      scoreCandidate('read', 'src/my-reader.ts'),
    );
    expect(scoreCandidate('rd', 'harddrive')).toBeGreaterThan(
      scoreCandidate('rd', 'reader'),
    );
    expect(scoreCandidate('zzz', 'reader')).toBe(Number.NEGATIVE_INFINITY);
  });

  it('同类匹配优先浅路径，并允许近期使用记录提升候选', () => {
    expect(scoreCandidate('a', 'a.ts')).toBeGreaterThan(
      scoreCandidate('a', 'deep/dir/a.ts'),
    );
    expect(scoreCandidate('a', 'a.ts', 50)).toBeGreaterThan(
      scoreCandidate('a', 'a.ts', 0),
    );
  });

  it('过滤不匹配项、遵守数量上限，并稳定处理同分候选', () => {
    expect(
      rankCandidates('re', ['recent', 'read', 'write', 'reader'], { limit: 2 }),
    ).toEqual(['read', 'reader']);
    expect(rankCandidates('', ['beta', 'alpha'])).toEqual(['alpha', 'beta']);
  });

  it('更新近期使用记录时不修改原记录，并衰减其它候选', () => {
    const previous = new Map([['other', 10]]);
    const next = bumpFrecency(previous, 'chosen');

    expect(previous).toEqual(new Map([['other', 10]]));
    expect(next).toEqual(
      new Map([
        ['other', 9],
        ['chosen', 50],
      ]),
    );
  });
});
