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
} from '../../src/tui/store/composer-buffer.js';

describe('输入缓冲区构造与插入', () => {
  it('往返保留多行文本，并把光标放在文本末尾', () => {
    const buffer = fromText('a\nbc');

    expect(buffer.cursor).toEqual({ line: 1, column: 2 });
    expect(toText(buffer)).toBe('a\nbc');
    expect(isEmpty(emptyBuffer)).toBe(true);
    expect(isEmpty(buffer)).toBe(false);
  });

  it('在光标处插入文本和换行，并规范化终端换行符', () => {
    let buffer = insertText(emptyBuffer, 'ab');
    buffer = moveLeft(buffer);
    buffer = insertText(buffer, 'X\r\nY');

    expect(toText(buffer)).toBe('aX\nYb');
    expect(buffer.cursor).toEqual({ line: 1, column: 1 });
    expect(toText(insertNewline(fromText('tail')))).toBe('tail\n');
  });
});

describe('输入缓冲区删除', () => {
  it('退格和向后删除可跨行合并文本', () => {
    const atSecondLineStart = moveLineStart(fromText('ab\ncd'));
    const mergedBackward = backspace(atSecondLineStart);

    expect(toText(mergedBackward)).toBe('abcd');
    expect(mergedBackward.cursor).toEqual({ line: 0, column: 2 });

    const atFirstLineEnd = moveLineEnd(moveUp(fromText('ab\ncd')));
    expect(toText(deleteForward(atFirstLineEnd))).toBe('abcd');
  });

  it('删除前一个单词及光标两侧行内容', () => {
    expect(toText(deleteWordBackward(fromText('hello world')))).toBe('hello ');

    const middle = moveRight(moveRight(moveLineStart(fromText('hello'))));
    expect(toText(killToLineEnd(middle))).toBe('he');
    expect(toText(killToLineStart(middle))).toBe('llo');
  });

  it('在文档首尾删除时保持文本不变', () => {
    expect(toText(backspace(emptyBuffer))).toBe('');
    expect(toText(deleteForward(fromText('end')))).toBe('end');
  });
});

describe('输入缓冲区光标移动', () => {
  it('左右移动可跨越行边界，但不会越过文档边界', () => {
    let buffer = moveLineStart(fromText('ab\ncd'));
    buffer = moveLeft(buffer);
    expect(buffer.cursor).toEqual({ line: 0, column: 2 });
    buffer = moveRight(buffer);
    expect(buffer.cursor).toEqual({ line: 1, column: 0 });

    expect(moveLeft(emptyBuffer).cursor).toEqual({ line: 0, column: 0 });
    expect(moveRight(fromText('end')).cursor).toEqual({ line: 0, column: 3 });
  });

  it('在长短不一的行之间移动时把列号限制在有效范围', () => {
    let buffer = moveUp(fromText('long line\nx'));
    expect(buffer.cursor).toEqual({ line: 0, column: 1 });
    buffer = moveLineEnd(buffer);
    buffer = moveDown(buffer);
    expect(buffer.cursor).toEqual({ line: 1, column: 1 });
  });
});
