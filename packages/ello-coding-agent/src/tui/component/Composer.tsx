import { Box, Text, useInput } from 'ink';
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
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  toText,
  type ComposerBuffer,
} from '../store/composer-buffer.js';
import { useTheme } from '../theme/index.js';

export interface ComposerProps {
  readonly running: boolean;
  readonly isActive?: boolean;
  readonly suggestions?: readonly ComposerSuggestion[];
  readonly history?: readonly string[];
  readonly value?: string;
  onChange?(
    value: string,
    cursor: { readonly line: number; readonly column: number },
  ): void;
  onSuggestionAccepted?(suggestion: ComposerSuggestion): void;
  onSubmit(value: string): void;
  onCancel(): void;
  onEscape(): void;
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
  const { onChange } = props;
  const [buffer, setBuffer] = useState<ComposerBuffer>(emptyBuffer);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const bufferRef = useRef(buffer);

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
    const current = historyIndex ?? history.length;
    const next = Math.max(0, Math.min(history.length, current + delta));
    setHistoryIndex(next === history.length ? null : next);
    replaceBuffer(
      next === history.length ? emptyBuffer : fromText(history[next] ?? ''),
    );
  };

  const submit = (): void => {
    const value = toText(bufferRef.current);
    props.onSubmit(value);
    if (value.trim() !== '') {
      setHistoryIndex(null);
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
      if (key.return) {
        if (shouldInsertLineBreak(current, key)) {
          replaceBuffer(insertNewline(dropTrailingLineContinuation(current)));
        } else {
          submit();
        }
        return;
      }
      if (key.tab) {
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
        if (!isEmpty(current)) {
          setHistoryIndex(null);
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
        if (current.lines.length > 1 && current.cursor.line > 0) {
          replaceBuffer(moveUp(current));
        } else if (
          props.suggestions !== undefined &&
          props.suggestions.length > 0
        ) {
          moveSuggestion(-1);
        } else if (isEmpty(current) || historyIndex !== null) {
          moveHistory(-1);
        }
        return;
      }
      if (key.downArrow) {
        if (
          current.lines.length > 1 &&
          current.cursor.line < current.lines.length - 1
        ) {
          replaceBuffer(moveDown(current));
        } else if (
          props.suggestions !== undefined &&
          props.suggestions.length > 0
        ) {
          moveSuggestion(1);
        } else if (isEmpty(current) || historyIndex !== null) {
          moveHistory(1);
        }
        return;
      }
      if (isBackspace(input, key)) {
        setHistoryIndex(null);
        replaceBuffer(backspace(current));
        return;
      }
      if (isDelete(input, key)) {
        setHistoryIndex(null);
        replaceBuffer(deleteForward(current));
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setHistoryIndex(null);
        replaceBuffer(insertText(current, input));
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

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {buffer.lines.map((line, index) => (
          <ComposerLine
            key={index}
            line={line}
            lineIndex={index}
            activeLine={buffer.cursor.line}
            cursorColumn={buffer.cursor.column}
            showCursor={showCursor}
            prompt={index === 0 ? '>' : '|'}
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

function ComposerLine({
  line,
  lineIndex,
  activeLine,
  cursorColumn,
  showCursor,
  prompt,
}: {
  readonly line: string;
  readonly lineIndex: number;
  readonly activeLine: number;
  readonly cursorColumn: number;
  readonly showCursor: boolean;
  readonly prompt: string;
}) {
  const theme = useTheme();
  const isCursorLine = lineIndex === activeLine;
  const beforeCursor = isCursorLine ? line.slice(0, cursorColumn) : line;
  const cursorChar = isCursorLine ? (line[cursorColumn] ?? ' ') : '';
  const afterCursor =
    isCursorLine && cursorColumn < line.length
      ? line.slice(cursorColumn + 1)
      : '';
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

const MAX_VISIBLE_SUGGESTIONS = 5;

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
