import stringWidth from 'string-width';

export interface TerminalGrapheme {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly displayWidth: number;
}

export interface TerminalVisualRow {
  readonly logicalLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly displayWidth: number;
}

export interface TerminalTextLayout {
  readonly rows: readonly TerminalVisualRow[];
  readonly cursorRow: number;
  readonly cursorDisplayColumn: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 按用户实际看到的字符切分文本，offset 仍使用 JavaScript 的 UTF-16 下标。 */
export function terminalGraphemes(text: string): readonly TerminalGrapheme[] {
  return [...segmenter.segment(text)].map((segment) => ({
    text: segment.segment,
    startOffset: segment.index,
    endOffset: segment.index + segment.segment.length,
    displayWidth: stringWidth(segment.segment),
  }));
}

export function previousGraphemeBoundary(text: string, offset: number): number {
  let previous = 0;
  for (const grapheme of terminalGraphemes(text)) {
    if (grapheme.endOffset >= offset) return grapheme.startOffset;
    previous = grapheme.endOffset;
  }
  return previous;
}

export function nextGraphemeBoundary(text: string, offset: number): number {
  for (const grapheme of terminalGraphemes(text)) {
    if (grapheme.endOffset > offset) return grapheme.endOffset;
  }
  return text.length;
}

/**
 * 生成 Composer 的唯一视觉布局。
 *
 * 逻辑行恰好占满终端宽度且光标位于行尾时，会保留一个空视觉行用于显示光标。
 */
export function layoutTerminalText(
  lines: readonly string[],
  cursor: { readonly line: number; readonly column: number },
  width: number,
): TerminalTextLayout {
  const safeWidth = Math.max(1, Math.floor(width));
  const rows: TerminalVisualRow[] = [];

  for (const [logicalLine, text] of lines.entries()) {
    const lineRows = wrapTerminalLine(text, logicalLine, safeWidth);
    rows.push(...lineRows);
    const last = lineRows.at(-1)!;
    if (
      logicalLine === cursor.line &&
      cursor.column === text.length &&
      last.displayWidth === safeWidth
    ) {
      rows.push({
        logicalLine,
        startOffset: text.length,
        endOffset: text.length,
        displayWidth: 0,
      });
    }
  }

  let cursorRow = 0;
  for (const [index, row] of rows.entries()) {
    if (row.logicalLine === cursor.line && row.startOffset <= cursor.column) {
      cursorRow = index;
    }
  }
  const activeRow = rows[cursorRow]!;
  return {
    rows,
    cursorRow,
    cursorDisplayColumn: displayWidthBetween(
      lines[cursor.line] ?? '',
      activeRow.startOffset,
      cursor.column,
    ),
  };
}

export function offsetAtDisplayColumn(
  text: string,
  row: TerminalVisualRow,
  displayColumn: number,
): number {
  const target = Math.max(0, displayColumn);
  let width = 0;
  let offset = row.startOffset;
  for (const grapheme of terminalGraphemes(text)) {
    if (
      grapheme.startOffset < row.startOffset ||
      grapheme.endOffset > row.endOffset
    ) {
      continue;
    }
    if (width + grapheme.displayWidth > target) return grapheme.startOffset;
    width += grapheme.displayWidth;
    offset = grapheme.endOffset;
  }
  return offset;
}

function wrapTerminalLine(
  text: string,
  logicalLine: number,
  width: number,
): readonly TerminalVisualRow[] {
  const graphemes = terminalGraphemes(text);
  if (graphemes.length === 0) {
    return [
      {
        logicalLine,
        startOffset: 0,
        endOffset: 0,
        displayWidth: 0,
      },
    ];
  }

  const rows: TerminalVisualRow[] = [];
  let startOffset = graphemes[0]!.startOffset;
  let endOffset = startOffset;
  let displayWidth = 0;
  for (const grapheme of graphemes) {
    if (displayWidth > 0 && displayWidth + grapheme.displayWidth > width) {
      rows.push({ logicalLine, startOffset, endOffset, displayWidth });
      startOffset = grapheme.startOffset;
      displayWidth = 0;
    }
    displayWidth += grapheme.displayWidth;
    endOffset = grapheme.endOffset;
  }
  rows.push({ logicalLine, startOffset, endOffset, displayWidth });
  return rows;
}

function displayWidthBetween(
  text: string,
  startOffset: number,
  endOffset: number,
): number {
  return terminalGraphemes(text)
    .filter(
      (grapheme) =>
        grapheme.startOffset >= startOffset && grapheme.endOffset <= endOffset,
    )
    .reduce((total, grapheme) => total + grapheme.displayWidth, 0);
}
