import { Box, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  moveDownVisual,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUpVisual,
  toText,
  type ComposerBuffer,
  visualLineCount,
} from '../store/composer-buffer.js';
import {
  formatPastePlaceholder,
  matchPastePlaceholderAtEnd,
  matchPastePlaceholderAtStart,
  PASTE_TRUNCATION_THRESHOLD,
  resolvePastePlaceholders,
} from '../store/composer-paste.js';
import {
  layoutTerminalText,
  nextGraphemeBoundary,
} from '../store/terminal-text.js';
import { useTheme } from '../theme/index.js';

export interface ComposerProps {
  readonly running: boolean;
  readonly isActive?: boolean;
  readonly suggestions?: readonly ComposerSuggestion[];
  readonly history?: readonly string[];
  readonly value?: string;
  readonly target?: string;
  readonly textWidth?: number;
  onChange?(
    value: string,
    cursor: { readonly line: number; readonly column: number },
  ): void;
  onSuggestionAccepted?(suggestion: ComposerSuggestion): void;
  onSubmit(value: string): void;
  onCancel(): void;
  onEscape(): void;
  onMovePastEnd?(): boolean;
}

export type ComposerSuggestion =
  | string
  | {
      readonly value: string;
      readonly label: string;
      readonly description?: string;
      readonly replaceFrom?: number;
      readonly replaceTo?: number;
      readonly appendSpace?: boolean;
    };

export function Composer(props: ComposerProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const { onChange } = props;
  const [buffer, setBuffer] = useState<ComposerBuffer>(emptyBuffer);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const historyIndexRef = useRef<number | null>(null);
  const bufferRef = useRef(buffer);
  const pastesRef = useRef<Map<number, string>>(new Map());
  const nextPasteIdRef = useRef(1);
  const wrapWidth = Math.max(
    1,
    props.textWidth ?? composerTextWidthForTerminal(stdout.columns ?? 100),
  );

  const replaceBuffer = useCallback(
    (next: ComposerBuffer): void => {
      bufferRef.current = next;
      setBuffer(next);
      onChange?.(toText(next), next.cursor);
    },
    [onChange],
  );

  useEffect(() => {
    if (
      props.value === undefined ||
      props.value === toText(bufferRef.current)
    ) {
      return;
    }
    replaceBuffer(fromText(props.value));
  }, [props.value, replaceBuffer]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCursorVisible((current) => !current);
    }, 530);
    return () => clearInterval(timer);
  }, []);

  const effectiveSuggestionIndex = (): number => {
    const count = props.suggestions?.length ?? 0;
    return count === 0 ? 0 : Math.min(suggestionIndex, count - 1);
  };

  const moveSuggestion = (delta: number): boolean => {
    const count = props.suggestions?.length ?? 0;
    if (count === 0) {
      return false;
    }
    setSuggestionIndex((current) => (current + delta + count) % count);
    return true;
  };

  const acceptSuggestion = (): void => {
    const suggestion = props.suggestions?.[effectiveSuggestionIndex()];
    if (suggestion === undefined) {
      return;
    }
    // 技能候选可能位于行中间，应用替换后再通知 App 记 frecency。
    replaceBuffer(applySuggestion(bufferRef.current, suggestion));
    props.onSuggestionAccepted?.(suggestion);
  };

  const moveHistory = (delta: number): void => {
    const history = props.history ?? [];
    if (history.length === 0) {
      return;
    }
    const current = historyIndexRef.current ?? history.length;
    const next = Math.max(0, Math.min(history.length, current + delta));
    historyIndexRef.current = next === history.length ? null : next;
    replaceBuffer(
      next === history.length ? emptyBuffer : fromText(history[next] ?? ''),
    );
  };

  const submit = (): void => {
    const value = toText(bufferRef.current);
    const pastes = pastesRef.current;
    if (pastes.size > 0) {
      const resolved = resolvePastePlaceholders(value, pastes);
      pastesRef.current = new Map();
      nextPasteIdRef.current = 1;
      props.onSubmit(resolved);
      if (resolved.trim() !== '') {
        historyIndexRef.current = null;
        replaceBuffer(emptyBuffer);
      }
      return;
    }
    props.onSubmit(value);
    if (value.trim() !== '') {
      historyIndexRef.current = null;
      replaceBuffer(emptyBuffer);
    }
  };

  useInput(
    (input, key) => {
      if (isTerminalMouseSequence(input)) {
        return;
      }
      const current = bufferRef.current;
      if (key.escape) {
        props.onEscape();
        return;
      }
      if (isShiftEnter(input, key)) {
        replaceBuffer(insertNewline(current));
        return;
      }
      if (key.return) {
        if (shouldInsertLineBreak(current, key)) {
          replaceBuffer(insertNewline(dropTrailingLineContinuation(current)));
        } else {
          submit();
        }
        return;
      }
      if (key.tab) {
        if (key.shift || input === '\u001b[Z') return;
        acceptSuggestion();
        return;
      }
      if (key.ctrl && input === 'a') {
        replaceBuffer(moveLineStart(current));
        return;
      }
      if (key.ctrl && input === 'e') {
        replaceBuffer(moveLineEnd(current));
        return;
      }
      if (key.ctrl && input === 'k') {
        replaceBuffer(killToLineEnd(current));
        return;
      }
      if (key.ctrl && input === 'u') {
        replaceBuffer(killToLineStart(current));
        return;
      }
      if (key.ctrl && input === 'w') {
        replaceBuffer(deleteWordBackward(current));
        return;
      }
      if (key.ctrl && input === 'c') {
        if (props.running) {
          props.onCancel();
        } else if (!isEmpty(current)) {
          historyIndexRef.current = null;
          pastesRef.current = new Map();
          nextPasteIdRef.current = 1;
          replaceBuffer(emptyBuffer);
        } else {
          props.onCancel();
        }
        return;
      }
      if (key.leftArrow) {
        replaceBuffer(moveLeft(current));
        return;
      }
      if (key.rightArrow) {
        replaceBuffer(moveRight(current));
        return;
      }
      if (key.upArrow) {
        if (visualLineCount(current, wrapWidth) > 1) {
          const moved = moveUpVisual(current, wrapWidth);
          if (moved !== current) replaceBuffer(moved);
          else if (historyIndexRef.current === null) return;
        } else if (historyIndexRef.current !== null) {
          moveHistory(-1);
        } else if (
          props.suggestions !== undefined &&
          props.suggestions.length > 0
        ) {
          moveSuggestion(-1);
        } else if (isEmpty(current)) {
          moveHistory(-1);
        }
        return;
      }
      if (key.downArrow) {
        if (props.suggestions !== undefined && props.suggestions.length > 0) {
          moveSuggestion(1);
        } else if (visualLineCount(current, wrapWidth) > 1) {
          const moved = moveDownVisual(current, wrapWidth);
          if (moved !== current) replaceBuffer(moved);
          else if (historyIndexRef.current === null) {
            const handled = props.onMovePastEnd?.() ?? false;
            if (!handled && isEmpty(current)) moveHistory(1);
          }
        } else if (historyIndexRef.current !== null) {
          moveHistory(1);
        } else {
          const handled = props.onMovePastEnd?.() ?? false;
          if (!handled && isEmpty(current)) moveHistory(1);
        }
        return;
      }
      if (isBackspace(input, key)) {
        historyIndexRef.current = null;
        const line = current.lines[current.cursor.line] ?? '';
        const before = line.slice(0, current.cursor.column);
        const ph = matchPastePlaceholderAtEnd(before);
        if (ph !== null) {
          pastesRef.current.delete(ph.id);
          const lines = [...current.lines];
          lines[current.cursor.line] =
            line.slice(0, current.cursor.column - ph.length) +
            line.slice(current.cursor.column);
          replaceBuffer({
            lines,
            cursor: {
              line: current.cursor.line,
              column: current.cursor.column - ph.length,
            },
          });
        } else {
          replaceBuffer(backspace(current));
        }
        return;
      }
      if (isDelete(input, key)) {
        historyIndexRef.current = null;
        const line = current.lines[current.cursor.line] ?? '';
        const after = line.slice(current.cursor.column);
        const ph = matchPastePlaceholderAtStart(after);
        if (ph !== null) {
          pastesRef.current.delete(ph.id);
          const lines = [...current.lines];
          lines[current.cursor.line] =
            line.slice(0, current.cursor.column) +
            line.slice(current.cursor.column + ph.length);
          replaceBuffer({ lines, cursor: current.cursor });
        } else {
          replaceBuffer(deleteForward(current));
        }
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        historyIndexRef.current = null;
        if (input.length > PASTE_TRUNCATION_THRESHOLD) {
          const pasteId = nextPasteIdRef.current;
          nextPasteIdRef.current += 1;
          pastesRef.current.set(pasteId, input);
          replaceBuffer(
            insertText(current, formatPastePlaceholder(input.length, pasteId)),
          );
        } else {
          replaceBuffer(insertText(current, input));
        }
      }
    },
    { isActive: props.isActive !== false },
  );

  const showCursor = props.isActive !== false && cursorVisible;
  const activeSuggestionIndex = effectiveSuggestionIndex();
  const visibleSuggestions = visibleSuggestionWindow(
    props.suggestions ?? [],
    activeSuggestionIndex,
  );
  const visualLines = wrapComposerLines(buffer, wrapWidth);

  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      {props.target === undefined ? null : (
        <Text color={theme.accent}>{`Steer @${props.target}`}</Text>
      )}
      <Box flexDirection="column" width="100%">
        {visualLines.map((visualLine, index) => (
          <ComposerLine
            key={`${visualLine.lineIndex}:${visualLine.start}`}
            line={visualLine.text}
            lineIndex={index}
            activeLine={visualLine.active ? index : -1}
            cursorOffset={visualLine.cursorOffset}
            showCursor={showCursor}
            prompt={visualLine.continuation ? '|' : '>'}
          />
        ))}
      </Box>
      {props.suggestions !== undefined && props.suggestions.length > 0 ? (
        <Box marginLeft={2} flexDirection="column">
          {visibleSuggestions.items.map((item, index) => (
            <SuggestionLine
              key={typeof item === 'string' ? item : item.value}
              item={item}
              active={
                index + visibleSuggestions.start === activeSuggestionIndex
              }
            />
          ))}
        </Box>
      ) : null}
      {props.running ? (
        <Text color={theme.textMuted}>Enter steers this run</Text>
      ) : null}
    </Box>
  );
}

interface VisualComposerLine {
  readonly lineIndex: number;
  readonly start: number;
  readonly text: string;
  readonly active: boolean;
  readonly cursorOffset: number;
  readonly continuation: boolean;
}

function wrapComposerLines(
  buffer: ComposerBuffer,
  width: number,
): readonly VisualComposerLine[] {
  const layout = layoutTerminalText(buffer.lines, buffer.cursor, width);
  return layout.rows.map((row, index) => ({
    lineIndex: row.logicalLine,
    start: row.startOffset,
    text: (buffer.lines[row.logicalLine] ?? '').slice(
      row.startOffset,
      row.endOffset,
    ),
    active: index === layout.cursorRow,
    cursorOffset:
      index === layout.cursorRow ? buffer.cursor.column - row.startOffset : 0,
    continuation: row.logicalLine > 0 || row.startOffset > 0,
  }));
}

function ComposerLine({
  line,
  lineIndex,
  activeLine,
  cursorOffset,
  showCursor,
  prompt,
}: {
  readonly line: string;
  readonly lineIndex: number;
  readonly activeLine: number;
  readonly cursorOffset: number;
  readonly showCursor: boolean;
  readonly prompt: string;
}) {
  const theme = useTheme();
  const isCursorLine = lineIndex === activeLine;
  const beforeCursor = isCursorLine ? line.slice(0, cursorOffset) : line;
  const cursorEnd = isCursorLine
    ? nextGraphemeBoundary(line, cursorOffset)
    : cursorOffset;
  const cursorChar = isCursorLine
    ? line.slice(cursorOffset, cursorEnd) || ' '
    : '';
  const afterCursor =
    isCursorLine && cursorOffset < line.length ? line.slice(cursorEnd) : '';
  return (
    <Box gap={1}>
      <Text color={theme.accent}>{prompt}</Text>
      <Text color={theme.text} wrap="wrap">
        {beforeCursor}
        {isCursorLine ? (
          <Text
            color={
              showCursor ? theme.accent : (theme.background ?? theme.panel)
            }
            inverse={showCursor}
          >
            {cursorChar}
          </Text>
        ) : null}
        {afterCursor}
      </Text>
    </Box>
  );
}

/** 把 AppShell、边框、padding、提示符和 gap 占用的宽度集中在一处。 */
export function composerTextWidthForTerminal(columns: number): number {
  const appPadding = 2;
  const dockBorder = 2;
  const dockPadding = 2;
  const composerPadding = 2;
  const promptAndGap = 2;
  return Math.max(
    1,
    columns -
      appPadding -
      dockBorder -
      dockPadding -
      composerPadding -
      promptAndGap,
  );
}

const MAX_VISIBLE_SUGGESTIONS = 5;

/**
 * Composer 实际占用的终端行数。
 *
 * 必须和上面的 JSX 保持一致：除了输入文本的视觉行，运行中还有 `Enter steers this
 * run`、查看 child 时有 `Steer @target`、有候选时还有补全列表。live 区的行数预算靠这个
 * 数字扣减，少算一行就会让 dynamic frame 顶到终端高度，触发 Ink 的整屏重绘。
 */
export function composerRowCount(input: {
  readonly textRows: number;
  readonly running: boolean;
  readonly hasSteerTarget: boolean;
  readonly suggestionCount: number;
}): number {
  return (
    (input.hasSteerTarget ? 1 : 0) +
    Math.max(1, input.textRows) +
    Math.min(input.suggestionCount, MAX_VISIBLE_SUGGESTIONS) +
    (input.running ? 1 : 0)
  );
}

function visibleSuggestionWindow(
  suggestions: readonly ComposerSuggestion[],
  activeIndex: number,
): { readonly items: readonly ComposerSuggestion[]; readonly start: number } {
  if (suggestions.length <= MAX_VISIBLE_SUGGESTIONS) {
    return { items: suggestions, start: 0 };
  }
  const start = Math.min(
    Math.max(0, activeIndex - MAX_VISIBLE_SUGGESTIONS + 1),
    suggestions.length - MAX_VISIBLE_SUGGESTIONS,
  );
  return {
    items: suggestions.slice(start, start + MAX_VISIBLE_SUGGESTIONS),
    start,
  };
}

function shouldInsertLineBreak(
  buffer: ComposerBuffer,
  key: {
    readonly shift?: boolean;
    readonly meta?: boolean;
    readonly alt?: boolean;
  },
): boolean {
  if (key.shift === true || key.meta === true || key.alt === true) {
    return true;
  }
  const line = buffer.lines[buffer.cursor.line] ?? '';
  return buffer.cursor.column === line.length && line.endsWith('\\');
}

function isShiftEnter(
  input: string,
  key: {
    readonly return?: boolean;
    readonly shift?: boolean;
    readonly meta?: boolean;
  },
): boolean {
  return (
    (key.return === true && (key.shift === true || key.meta === true)) ||
    input === '\u001b[13;2u' ||
    input === '\u001b[27;2;13~'
  );
}

function dropTrailingLineContinuation(buffer: ComposerBuffer): ComposerBuffer {
  const line = buffer.lines[buffer.cursor.line] ?? '';
  if (buffer.cursor.column !== line.length || !line.endsWith('\\')) {
    return buffer;
  }
  return backspace(buffer);
}

function applySuggestion(
  buffer: ComposerBuffer,
  suggestion: ComposerSuggestion,
): ComposerBuffer {
  const { line, column } = buffer.cursor;
  const current = buffer.lines[line] ?? '';
  const value = typeof suggestion === 'string' ? suggestion : suggestion.value;
  const start =
    typeof suggestion === 'string' || suggestion.replaceFrom === undefined
      ? completionStart(current.slice(0, column), value)
      : suggestion.replaceFrom;
  const end =
    typeof suggestion === 'string' || suggestion.replaceTo === undefined
      ? column
      : suggestion.replaceTo;
  const inserted = `${value}${typeof suggestion !== 'string' && suggestion.appendSpace === true ? ' ' : ''}`;
  const suffixStart =
    typeof suggestion !== 'string' &&
    suggestion.appendSpace === true &&
    /\s/u.test(current[end] ?? '')
      ? end + 1
      : end;
  const nextLine = `${current.slice(0, start)}${inserted}${current.slice(suffixStart)}`;
  const lines = [...buffer.lines];
  lines[line] = nextLine;
  return {
    lines,
    cursor: { line, column: start + inserted.length },
  };
}

function completionStart(textBeforeCursor: string, suggestion: string): number {
  if (suggestion.startsWith('/')) {
    return 0;
  }
  if (suggestion.startsWith('@')) {
    const start = tokenStart(textBeforeCursor, '@');
    if (start !== undefined) {
      return start;
    }
  }
  if (suggestion.startsWith('#')) {
    const start = tokenStart(textBeforeCursor, '#');
    if (start !== undefined) {
      return start;
    }
  }
  return 0;
}

function tokenStart(
  textBeforeCursor: string,
  symbol: '@' | '#' | '$',
): number | undefined {
  for (let index = textBeforeCursor.length - 1; index >= 0; index -= 1) {
    const char = textBeforeCursor[index];
    if (char === symbol) {
      const previous = index === 0 ? undefined : textBeforeCursor[index - 1];
      if (previous === undefined || /\s/u.test(previous)) {
        return index;
      }
      return undefined;
    }
    if (char !== undefined && /\s/u.test(char)) {
      return undefined;
    }
  }
  return undefined;
}

function isBackspace(
  input: string,
  key: { readonly backspace?: boolean; readonly delete?: boolean },
): boolean {
  return (
    key.backspace === true ||
    input === '\b' ||
    input === '\u007f' ||
    (key.delete === true && input === '')
  );
}

function isDelete(input: string, key: { readonly delete?: boolean }): boolean {
  return key.delete === true || input === '\u001b[3~';
}

function isTerminalMouseSequence(input: string): boolean {
  const escape = String.fromCharCode(27);
  return input.startsWith(`${escape}[<`) || input.startsWith('[<');
}

function SuggestionLine({
  item,
  active,
}: {
  readonly item: ComposerSuggestion;
  readonly active: boolean;
}) {
  const theme = useTheme();
  if (typeof item === 'string') {
    return (
      <Text color={active ? theme.accent : theme.textMuted}>
        {active ? `${item} <tab>` : item}
      </Text>
    );
  }
  return (
    <Text>
      <Text color={active ? theme.accent : theme.info}>
        {item.label.padEnd(16)}
      </Text>
      {item.description !== undefined ? (
        <Text color={theme.textMuted}>{item.description}</Text>
      ) : null}
      {active ? <Text color={theme.textMuted}> &lt;tab&gt;</Text> : null}
    </Text>
  );
}
