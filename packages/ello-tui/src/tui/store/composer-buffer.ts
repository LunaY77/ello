/**
 * 多行输入缓冲区。
 *
 * Composer 不再是单段字符串，而是 {lines, cursor} 的纯结构。所有编辑操作都是纯函数，
 * 返回新 buffer，便于单测，也让 React 端只负责渲染与按键分发。
 */
export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

export interface ComposerBuffer {
  readonly lines: readonly string[];
  readonly cursor: CursorPosition;
}

export const emptyBuffer: ComposerBuffer = {
  lines: [''],
  cursor: { line: 0, column: 0 },
};

export function fromText(text: string): ComposerBuffer {
  const lines = text.split('\n');
  const lastLine = lines.length - 1;
  return {
    lines,
    cursor: { line: lastLine, column: (lines[lastLine] ?? '').length },
  };
}

export function toText(buffer: ComposerBuffer): string {
  return buffer.lines.join('\n');
}

export function isEmpty(buffer: ComposerBuffer): boolean {
  return buffer.lines.length === 1 && buffer.lines[0] === '';
}

function lineAt(buffer: ComposerBuffer, index: number): string {
  return buffer.lines[index] ?? '';
}

function clampCursor(
  lines: readonly string[],
  cursor: CursorPosition,
): CursorPosition {
  const line = Math.max(0, Math.min(lines.length - 1, cursor.line));
  const column = Math.max(
    0,
    Math.min((lines[line] ?? '').length, cursor.column),
  );
  return { line, column };
}

/** 在光标处插入文本（可含换行）。 */
export function insertText(
  buffer: ComposerBuffer,
  text: string,
): ComposerBuffer {
  if (text === '') {
    return buffer;
  }
  const normalizedText = text.replace(/\r\n?/g, '\n');
  const { line, column } = buffer.cursor;
  const current = lineAt(buffer, line);
  const head = current.slice(0, column);
  const tail = current.slice(column);
  const inserted = normalizedText.split('\n');
  const firstInserted = inserted[0] ?? '';

  if (inserted.length === 1) {
    const nextLine = `${head}${firstInserted}${tail}`;
    const lines = [...buffer.lines];
    lines[line] = nextLine;
    return {
      lines,
      cursor: { line, column: column + firstInserted.length },
    };
  }

  const lastInserted = inserted[inserted.length - 1] ?? '';
  const newLines = [
    `${head}${firstInserted}`,
    ...inserted.slice(1, -1),
    `${lastInserted}${tail}`,
  ];
  const lines = [
    ...buffer.lines.slice(0, line),
    ...newLines,
    ...buffer.lines.slice(line + 1),
  ];
  return {
    lines,
    cursor: {
      line: line + inserted.length - 1,
      column: lastInserted.length,
    },
  };
}

export function insertNewline(buffer: ComposerBuffer): ComposerBuffer {
  return insertText(buffer, '\n');
}

/** 退格：删除光标前一个字符，必要时合并到上一行。 */
export function backspace(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  if (column > 0) {
    const current = lineAt(buffer, line);
    const nextLine = current.slice(0, column - 1) + current.slice(column);
    const lines = [...buffer.lines];
    lines[line] = nextLine;
    return { lines, cursor: { line, column: column - 1 } };
  }
  if (line === 0) {
    return buffer;
  }
  const previous = lineAt(buffer, line - 1);
  const current = lineAt(buffer, line);
  const merged = previous + current;
  const lines = [
    ...buffer.lines.slice(0, line - 1),
    merged,
    ...buffer.lines.slice(line + 1),
  ];
  return { lines, cursor: { line: line - 1, column: previous.length } };
}

/** 向后删除：删除光标处字符，必要时合并下一行。 */
export function deleteForward(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  const current = lineAt(buffer, line);
  if (column < current.length) {
    const nextLine = current.slice(0, column) + current.slice(column + 1);
    const lines = [...buffer.lines];
    lines[line] = nextLine;
    return { lines, cursor: buffer.cursor };
  }
  if (line >= buffer.lines.length - 1) {
    return buffer;
  }
  const next = lineAt(buffer, line + 1);
  const lines = [
    ...buffer.lines.slice(0, line),
    current + next,
    ...buffer.lines.slice(line + 2),
  ];
  return { lines, cursor: buffer.cursor };
}

export function moveLeft(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  if (column > 0) {
    return { ...buffer, cursor: { line, column: column - 1 } };
  }
  if (line === 0) {
    return buffer;
  }
  return {
    ...buffer,
    cursor: { line: line - 1, column: lineAt(buffer, line - 1).length },
  };
}

export function moveRight(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  if (column < lineAt(buffer, line).length) {
    return { ...buffer, cursor: { line, column: column + 1 } };
  }
  if (line >= buffer.lines.length - 1) {
    return buffer;
  }
  return { ...buffer, cursor: { line: line + 1, column: 0 } };
}

export function moveUp(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  if (line === 0) {
    return buffer;
  }
  return {
    ...buffer,
    cursor: clampCursor(buffer.lines, { line: line - 1, column }),
  };
}

export function moveDown(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  if (line >= buffer.lines.length - 1) {
    return buffer;
  }
  return {
    ...buffer,
    cursor: clampCursor(buffer.lines, { line: line + 1, column }),
  };
}

export function moveLineStart(buffer: ComposerBuffer): ComposerBuffer {
  return { ...buffer, cursor: { line: buffer.cursor.line, column: 0 } };
}

export function moveLineEnd(buffer: ComposerBuffer): ComposerBuffer {
  return {
    ...buffer,
    cursor: {
      line: buffer.cursor.line,
      column: lineAt(buffer, buffer.cursor.line).length,
    },
  };
}

/** Ctrl+K：删到行尾。 */
export function killToLineEnd(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  const current = lineAt(buffer, line);
  const lines = [...buffer.lines];
  lines[line] = current.slice(0, column);
  return { lines, cursor: buffer.cursor };
}

/** Ctrl+U：删到行首。 */
export function killToLineStart(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  const current = lineAt(buffer, line);
  const lines = [...buffer.lines];
  lines[line] = current.slice(column);
  return { lines, cursor: { line, column: 0 } };
}

/** Ctrl+W：删除光标前一个单词（含其后空白）。 */
export function deleteWordBackward(buffer: ComposerBuffer): ComposerBuffer {
  const { line, column } = buffer.cursor;
  if (column === 0) {
    return backspace(buffer);
  }
  const current = lineAt(buffer, line);
  const head = current.slice(0, column);
  const trimmed = head.replace(/[^\s]*\s*$/u, '');
  const lines = [...buffer.lines];
  lines[line] = trimmed + current.slice(column);
  return { lines, cursor: { line, column: trimmed.length } };
}
