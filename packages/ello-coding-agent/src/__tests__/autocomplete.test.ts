import { describe, expect, it } from 'vitest';

import {
  bumpFrecency,
  detectTrigger,
  rankCandidates,
  scoreCandidate,
} from '../tui/store/autocomplete.js';

describe('detectTrigger', () => {
  it('detects a command trigger only for a leading slash with no space', () => {
    expect(detectTrigger('/the')).toEqual({
      kind: 'command',
      query: 'the',
      tokenStart: 0,
    });
    expect(detectTrigger('/theme arg')).toBeUndefined();
  });

  it('detects @file and #mention at token boundaries', () => {
    expect(detectTrigger('look at @src/a')).toMatchObject({
      kind: 'file',
      query: 'src/a',
    });
    expect(detectTrigger('ping #task')).toMatchObject({
      kind: 'mention',
      query: 'task',
    });
  });

  it('ignores @ in the middle of a word (e.g. email)', () => {
    expect(detectTrigger('mail me@host')).toBeUndefined();
  });
});

describe('scoreCandidate', () => {
  it('ranks exact > prefix > basename > substring > subsequence', () => {
    expect(scoreCandidate('read', 'read')).toBeGreaterThan(
      scoreCandidate('read', 'reader'),
    );
    expect(scoreCandidate('read', 'reader')).toBeGreaterThan(
      scoreCandidate('rd', 'reader'),
    );
    expect(scoreCandidate('zzz', 'reader')).toBe(Number.NEGATIVE_INFINITY);
  });

  it('prefers shallower paths and applies frecency boost', () => {
    expect(scoreCandidate('a', 'a.ts')).toBeGreaterThan(
      scoreCandidate('a', 'deep/dir/a.ts'),
    );
    expect(scoreCandidate('a', 'a.ts', 50)).toBeGreaterThan(
      scoreCandidate('a', 'a.ts', 0),
    );
  });
});

describe('rankCandidates', () => {
  it('filters non-matches and respects the limit', () => {
    const ranked = rankCandidates('re', ['read', 'reader', 'write', 'recent'], {
      limit: 2,
    });
    expect(ranked).toHaveLength(2);
    expect(ranked).not.toContain('write');
  });

  it('lets frecency reorder otherwise-equal candidates', () => {
    const frecency = new Map([['beta', 100]]);
    const ranked = rankCandidates('', ['alpha', 'beta'], { frecency });
    expect(ranked[0]).toBe('beta');
  });
});

describe('bumpFrecency', () => {
  it('boosts the chosen key and lightly decays others', () => {
    const next = bumpFrecency(new Map([['other', 10]]), 'chosen');
    expect(next.get('chosen')).toBe(50);
    expect(next.get('other')).toBe(9);
  });
});
