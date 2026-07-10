import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { useTheme, type TuiTheme } from '../theme/index.js';

export interface SelectOption {
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
}

export interface InlineSelectProps {
  readonly options: readonly SelectOption[];
  readonly isActive?: boolean;
  readonly label?: string;
  readonly visibleRows?: number;
  onChange(value: string): void;
  onShortcut?(input: string, value: string): void;
}

/** Ink Select：上下/翻页移动，回车确认，并把当前项交给上层快捷键。 */
export function InlineSelect({
  options,
  isActive = true,
  label,
  visibleRows = options.length,
  onChange,
  onShortcut,
}: InlineSelectProps) {
  const theme = useTheme();
  const [index, setIndex] = useState(() => firstEnabledIndex(options));
  const selectedIndex = enabledIndexOrFirst(options, index);
  const windowSize = Math.max(1, visibleRows);
  const windowStart = windowStartFor(selectedIndex, options.length, windowSize);
  const visibleOptions = options.slice(windowStart, windowStart + windowSize);
  const windowEnd = windowStart + visibleOptions.length;

  useInput(
    (input, key) => {
      if (options.length === 0) {
        return;
      }
      if (key.upArrow) {
        setIndex((current) => previousEnabledIndex(options, current));
      } else if (key.downArrow) {
        setIndex((current) => nextEnabledIndex(options, current));
      } else if (key.pageUp || input === '\u001b[5~') {
        setIndex((current) =>
          enabledIndexAtOrBefore(
            options,
            Math.max(0, current - windowSize + 1),
          ),
        );
      } else if (key.pageDown || input === '\u001b[6~') {
        setIndex((current) =>
          enabledIndexAtOrAfter(
            options,
            Math.min(options.length - 1, current + windowSize - 1),
          ),
        );
      } else if (key.home || input === '\u001b[H') {
        setIndex(firstEnabledIndex(options));
      } else if (key.end || input === '\u001b[F') {
        setIndex(lastEnabledIndex(options));
      } else if (key.return) {
        const selected = options[selectedIndex];
        if (selected !== undefined && selected.disabled !== true) {
          onChange(selected.value);
        }
      } else if (input.length > 0 && onShortcut !== undefined) {
        const selected = options[selectedIndex];
        if (selected !== undefined && selected.disabled !== true) {
          onShortcut(input, selected.value);
        }
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {label !== undefined ? (
        <Text color={theme.textMuted}>
          {`${label}  ${windowStart + 1}-${windowEnd} of ${options.length}`}
        </Text>
      ) : null}
      {visibleOptions.map((option, offset) => {
        const optionIndex = windowStart + offset;
        return (
          <Text
            key={option.value}
            color={colorForOption(theme, option, optionIndex === selectedIndex)}
          >
            {`${optionIndex === selectedIndex && option.disabled !== true ? '›' : ' '} ${option.label}`}
          </Text>
        );
      })}
      {options.length > windowSize ? (
        <Text color={theme.textMuted}>{`scrollbar  ${scrollbar(
          windowStart,
          windowEnd,
          options.length,
        )}`}</Text>
      ) : null}
    </Box>
  );
}

function enabledIndexOrFirst(
  options: readonly SelectOption[],
  index: number,
): number {
  const selected = options[index];
  return selected !== undefined && selected.disabled !== true
    ? index
    : firstEnabledIndex(options);
}

function firstEnabledIndex(options: readonly SelectOption[]): number {
  const index = options.findIndex((option) => option.disabled !== true);
  return index === -1 ? 0 : index;
}

function lastEnabledIndex(options: readonly SelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (options[index]?.disabled !== true) {
      return index;
    }
  }
  return 0;
}

function previousEnabledIndex(
  options: readonly SelectOption[],
  current: number,
): number {
  for (let index = current - 1; index >= 0; index -= 1) {
    if (options[index]?.disabled !== true) {
      return index;
    }
  }
  return current;
}

function nextEnabledIndex(
  options: readonly SelectOption[],
  current: number,
): number {
  for (let index = current + 1; index < options.length; index += 1) {
    if (options[index]?.disabled !== true) {
      return index;
    }
  }
  return current;
}

function enabledIndexAtOrBefore(
  options: readonly SelectOption[],
  current: number,
): number {
  for (
    let index = Math.min(current, options.length - 1);
    index >= 0;
    index -= 1
  ) {
    if (options[index]?.disabled !== true) {
      return index;
    }
  }
  return firstEnabledIndex(options);
}

function enabledIndexAtOrAfter(
  options: readonly SelectOption[],
  current: number,
): number {
  for (let index = Math.max(0, current); index < options.length; index += 1) {
    if (options[index]?.disabled !== true) {
      return index;
    }
  }
  return lastEnabledIndex(options);
}

function windowStartFor(
  selectedIndex: number,
  total: number,
  windowSize: number,
): number {
  if (total <= windowSize) {
    return 0;
  }
  const half = Math.floor(windowSize / 2);
  return Math.min(Math.max(0, selectedIndex - half), total - windowSize);
}

function scrollbar(start: number, end: number, total: number): string {
  const width = 10;
  const filledStart = Math.floor((start / total) * width);
  const filledEnd = Math.max(filledStart + 1, Math.ceil((end / total) * width));
  return `[${Array.from({ length: width }, (_, index) =>
    index >= filledStart && index < filledEnd ? '#' : '-',
  ).join('')}]`;
}

function colorForOption(
  theme: TuiTheme,
  option: SelectOption,
  selected: boolean,
): string {
  if (option.disabled === true) {
    return theme.textMuted;
  }
  return selected ? theme.accent : theme.text;
}
