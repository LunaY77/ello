import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { tokyoNight } from '../tokyo-night.js';

export interface SelectOption {
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
}

export interface InlineSelectProps {
  readonly options: readonly SelectOption[];
  readonly isActive?: boolean;
  onChange(value: string): void;
  onShortcut?(input: string, value: string): void;
}

/** 极简 Ink Select：上下移动，回车确认，并把当前项交给上层快捷键。 */
export function InlineSelect({
  options,
  isActive = true,
  onChange,
  onShortcut,
}: InlineSelectProps) {
  const [index, setIndex] = useState(() => firstEnabledIndex(options));
  const selectedIndex = enabledIndexOrFirst(options, index);

  useInput(
    (_input, key) => {
      if (options.length === 0) {
        return;
      }
      if (key.upArrow) {
        setIndex((current) => previousEnabledIndex(options, current));
      } else if (key.downArrow) {
        setIndex((current) => nextEnabledIndex(options, current));
      } else if (key.return) {
        const selected = options[selectedIndex];
        if (selected !== undefined && selected.disabled !== true) {
          onChange(selected.value);
        }
      } else if (_input.length > 0 && onShortcut !== undefined) {
        const selected = options[selectedIndex];
        if (selected !== undefined && selected.disabled !== true) {
          onShortcut(_input, selected.value);
        }
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {options.map((option, optionIndex) => (
        <Text
          key={option.value}
          color={colorForOption(option, optionIndex === selectedIndex)}
        >
          {`${optionIndex === selectedIndex && option.disabled !== true ? '›' : ' '} ${option.label}`}
        </Text>
      ))}
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

function colorForOption(option: SelectOption, selected: boolean): string {
  if (option.disabled === true) {
    return tokyoNight.muted;
  }
  return selected ? tokyoNight.cyan : tokyoNight.foreground;
}
