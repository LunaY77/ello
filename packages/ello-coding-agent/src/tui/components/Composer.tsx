import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';

import { tokyoNight } from '../tokyo-night.js';

export interface ComposerProps {
  /** 是否运行中：决定回车语义是 steer 还是 submit。 */
  readonly running: boolean;
  /** overlay 抢焦点时置 false，输入被忽略。 */
  readonly isActive?: boolean;
  /** `/`、`@` 补全建议。 */
  readonly suggestions?: readonly ComposerSuggestion[];
  /** 输入历史，空输入时可用上下键遍历。 */
  readonly history?: readonly string[];
  /** 外部设置的输入值，用于 rewind 等运行时动作回填 Composer。 */
  readonly value?: string;
  /** 输入内容变化，用于 App 计算补全和 Ctrl+C 语义。 */
  onChange?(value: string): void;
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
    };

/**
 * 输入区。
 *
 * 这里用 Ink 原生 `useInput`，避免 `@inkjs/ui` 组合组件在 Ink 6 下产生
 * `<Box>` 嵌套进 `<Text>` 的运行时错误。提交后本地清空输入，App 负责把输入
 * 解释成 submit / steer / slash command / shell escape。
 */
export function Composer(props: ComposerProps) {
  const { onChange } = props;
  const [value, setValue] = useState('');
  const [cursorIndex, setCursorIndex] = useState(0);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const valueRef = useRef(value);
  const cursorIndexRef = useRef(cursorIndex);

  const updateValue = useCallback(
    (next: string, nextCursorIndex = next.length): void => {
      const normalizedCursorIndex = Math.max(
        0,
        Math.min(next.length, nextCursorIndex),
      );
      valueRef.current = next;
      cursorIndexRef.current = normalizedCursorIndex;
      setValue(next);
      setCursorIndex(normalizedCursorIndex);
      onChange?.(next);
    },
    [onChange],
  );

  useEffect(() => {
    if (props.value === undefined || props.value === valueRef.current) {
      return;
    }
    updateValue(props.value);
  }, [props.value, updateValue]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCursorVisible((current) => !current);
    }, 530);
    return () => clearInterval(timer);
  }, []);

  const updateCursorIndex = (next: number): void => {
    const normalizedCursorIndex = Math.max(
      0,
      Math.min(valueRef.current.length, next),
    );
    cursorIndexRef.current = normalizedCursorIndex;
    setCursorIndex(normalizedCursorIndex);
  };

  const acceptSuggestion = (): void => {
    const suggestion = props.suggestions?.[effectiveSuggestionIndex()];
    if (suggestion === undefined) {
      return;
    }
    const next = typeof suggestion === 'string' ? suggestion : suggestion.value;
    updateValue(next);
  };

  const moveSuggestion = (delta: number): boolean => {
    const count = props.suggestions?.length ?? 0;
    if (count === 0) {
      return false;
    }
    setSuggestionIndex((current) => (current + delta + count) % count);
    return true;
  };

  const effectiveSuggestionIndex = (): number => {
    const count = props.suggestions?.length ?? 0;
    return count === 0 ? 0 : Math.min(suggestionIndex, count - 1);
  };

  const moveHistory = (delta: number): void => {
    const history = props.history ?? [];
    if (history.length === 0) {
      return;
    }
    const current = historyIndex ?? history.length;
    const next = Math.max(0, Math.min(history.length, current + delta));
    setHistoryIndex(next === history.length ? null : next);
    updateValue(next === history.length ? '' : (history[next] ?? ''));
  };

  useInput(
    (input, key) => {
      const currentValue = valueRef.current;
      const currentCursorIndex = cursorIndexRef.current;
      if (key.return) {
        const submitted = currentValue;
        props.onSubmit(submitted);
        if (submitted.trim() !== '') {
          setHistoryIndex(null);
          updateValue('');
        }
        return;
      }
      if (key.leftArrow) {
        updateCursorIndex(currentCursorIndex - 1);
        return;
      }
      if (key.rightArrow) {
        updateCursorIndex(currentCursorIndex + 1);
        return;
      }
      if (key.upArrow) {
        if (props.suggestions !== undefined && props.suggestions.length > 0) {
          moveSuggestion(-1);
        } else if (value === '') {
          moveHistory(-1);
        }
        return;
      }
      if (key.downArrow) {
        if (props.suggestions !== undefined && props.suggestions.length > 0) {
          moveSuggestion(1);
        } else if (value === '' || historyIndex !== null) {
          moveHistory(1);
        }
        return;
      }
      if (key.tab) {
        acceptSuggestion();
        return;
      }
      if (key.ctrl && input === 'c') {
        if (currentValue.length > 0) {
          setHistoryIndex(null);
          updateValue('');
        } else {
          props.onCancel();
        }
        return;
      }
      if (isBackspace(input, key) || isDelete(input, key)) {
        setHistoryIndex(null);
        if (currentCursorIndex > 0) {
          updateValue(
            currentValue.slice(0, currentCursorIndex - 1) +
              currentValue.slice(currentCursorIndex),
            currentCursorIndex - 1,
          );
        }
        return;
      }
      if (key.escape) {
        props.onEscape();
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setHistoryIndex(null);
        updateValue(
          currentValue.slice(0, currentCursorIndex) +
            input +
            currentValue.slice(currentCursorIndex),
          currentCursorIndex + input.length,
        );
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
  const beforeCursor = value.slice(0, cursorIndex);
  const cursorChar = value[cursorIndex] ?? ' ';
  const afterCursor =
    cursorIndex < value.length ? value.slice(cursorIndex + 1) : '';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text color={tokyoNight.cyan}>{'>'}</Text>
        <Text color={tokyoNight.foreground} wrap="wrap">
          {beforeCursor}
          <Text
            color={showCursor ? tokyoNight.cyan : tokyoNight.background}
            inverse={showCursor}
          >
            {cursorChar}
          </Text>
          {afterCursor}
        </Text>
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

function isBackspace(
  input: string,
  key: { readonly backspace?: boolean },
): boolean {
  return key.backspace === true || input === '\b' || input === '\u007f';
}

function isDelete(input: string, key: { readonly delete?: boolean }): boolean {
  return key.delete === true || input === '\u001b[3~';
}

function SuggestionLine({
  item,
  active,
}: {
  readonly item: ComposerSuggestion;
  readonly active: boolean;
}) {
  if (typeof item === 'string') {
    return (
      <Text color={active ? tokyoNight.cyan : tokyoNight.muted}>
        {active ? `${item} <tab>` : item}
      </Text>
    );
  }
  return (
    <Text>
      <Text color={active ? tokyoNight.cyan : tokyoNight.blue}>
        {item.label.padEnd(16)}
      </Text>
      {item.description !== undefined ? (
        <Text color={tokyoNight.muted}>{item.description}</Text>
      ) : null}
      {active ? <Text color={tokyoNight.muted}> &lt;tab&gt;</Text> : null}
    </Text>
  );
}
