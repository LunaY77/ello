import { describe, expect, it } from 'vitest';

import {
  backspace,
  deleteForward,
  deleteWordBackward,
  emptyBuffer,
  fromText,
  insertNewline,
  insertText,
  isEmpty,
  killToLineEnd,
  killToLineStart,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  toText,
} from '../tui/store/composer-buffer.js';

describe('composer-buffer construction', () => {
  it('round-trips multiline text and tracks emptiness', () => {
    const buffer = fromText('a\nbc');
    expect(buffer.cursor).toEqual({ line: 1, column: 2 });
    expect(toText(buffer)).toBe('a\nbc');
    expect(isEmpty(emptyBuffer)).toBe(true);
    expect(isEmpty(buffer)).toBe(false);
  });
});

describe('insertText', () => {
  it('inserts inline text and advances the cursor', () => {
    const buffer = insertText(emptyBuffer, 'hello');
    expect(toText(buffer)).toBe('hello');
    expect(buffer.cursor).toEqual({ line: 0, column: 5 });
  });

  it('splits into multiple lines on newline', () => {
    const buffer = insertNewline(insertText(emptyBuffer, 'ab'));
    expect(buffer.lines).toEqual(['ab', '']);
    expect(buffer.cursor).toEqual({ line: 1, column: 0 });
  });
});

describe('deletion', () => {
  it('backspace merges into the previous line at column 0', () => {
    const merged = backspace(moveLineStart(fromText('ab\ncd')));
    expect(toText(merged)).toBe('abcd');
    expect(merged.cursor).toEqual({ line: 0, column: 2 });
  });

  it('deleteForward pulls up the next line at end of line', () => {
    let buffer = fromText('ab\ncd');
    buffer = moveLineStart(moveUp(buffer)); // line 0 col 0
    buffer = moveLineEnd(buffer); // line 0 col 2
    expect(toText(deleteForward(buffer))).toBe('abcd');
  });

  it('deleteWordBackward removes the preceding word', () => {
    const buffer = deleteWordBackward(fromText('hello world'));
    expect(toText(buffer)).toBe('hello ');
  });

  it('killToLineEnd and killToLineStart cut around the cursor', () => {
    let buffer = fromText('hello');
    buffer = moveLineStart(buffer);
    buffer = moveRight(moveRight(buffer)); // col 2
    expect(toText(killToLineEnd(buffer))).toBe('he');
    expect(toText(killToLineStart(buffer))).toBe('llo');
  });
});

describe('cursor movement', () => {
  it('wraps left/right across line boundaries', () => {
    let buffer = fromText('ab\ncd');
    buffer = moveLineStart(buffer); // line 1 col 0
    buffer = moveLeft(buffer); // wraps to end of line 0
    expect(buffer.cursor).toEqual({ line: 0, column: 2 });
    buffer = moveRight(buffer); // back to line 1 col 0
    expect(buffer.cursor).toEqual({ line: 1, column: 0 });
  });

  it('clamps column when moving up/down between uneven lines', () => {
    let buffer = fromText('long line\nx');
    expect(buffer.cursor).toEqual({ line: 1, column: 1 });
    buffer = moveUp(buffer);
    expect(buffer.cursor.line).toBe(0);
    buffer = moveDown(buffer);
    expect(buffer.cursor.line).toBe(1);
  });
});
