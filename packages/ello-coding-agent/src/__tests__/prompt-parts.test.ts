import { describe, expect, it } from 'vitest';

import {
  hasFileParts,
  parsePromptParts,
  partsToDisplayText,
  serializeForModel,
} from '../tui/store/prompt-parts.js';

describe('parsePromptParts', () => {
  it('splits text and @file mentions with optional line ranges', () => {
    const parts = parsePromptParts('see @src/a.ts#10-20 here');
    expect(parts).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'file', path: 'src/a.ts', lineStart: 10, lineEnd: 20 },
      { type: 'text', text: ' here' },
    ]);
  });

  it('treats a single line number as a one-line range', () => {
    const parts = parsePromptParts('@a.ts#5');
    expect(parts[0]).toEqual({
      type: 'file',
      path: 'a.ts',
      lineStart: 5,
      lineEnd: 5,
    });
  });

  it('does not treat mid-word @ as a mention', () => {
    expect(parsePromptParts('me@host.com')).toEqual([
      { type: 'text', text: 'me@host.com' },
    ]);
  });

  it('returns a single text part when there are no mentions', () => {
    expect(parsePromptParts('plain text')).toEqual([
      { type: 'text', text: 'plain text' },
    ]);
  });
});

describe('partsToDisplayText / hasFileParts', () => {
  it('round-trips a ranged mention back to display text', () => {
    const parts = parsePromptParts('check @a.ts#3-4 now');
    expect(partsToDisplayText(parts)).toBe('check @a.ts#3-4 now');
    expect(hasFileParts(parts)).toBe(true);
  });
});

describe('serializeForModel', () => {
  it('inlines file content within a sliced line range', async () => {
    const result = await serializeForModel(
      parsePromptParts('top @a.ts#2-3 end'),
      {
        cwd: '/repo',
        resolvePath: (cwd, rel) => `${cwd}/${rel}`,
        readFile: async () => 'L1\nL2\nL3\nL4',
      },
    );
    expect(result).toContain('top ');
    expect(result).toContain('<attached-file path="a.ts" lines="2-3">');
    expect(result).toContain('L2\nL3');
    expect(result).not.toContain('L1');
  });
});
