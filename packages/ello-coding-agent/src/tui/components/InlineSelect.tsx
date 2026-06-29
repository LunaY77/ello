import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { tokyoNight } from '../tokyo-night.js';

export interface SelectOption {
  readonly label: string;
  readonly value: string;
}

export interface InlineSelectProps {
  readonly options: readonly SelectOption[];
  readonly isActive?: boolean;
  onChange(value: string): void;
}

/** 极简 Ink Select：上下移动，回车确认。 */
export function InlineSelect({
  options,
  isActive = true,
  onChange,
}: InlineSelectProps) {
  const [index, setIndex] = useState(0);

  useInput(
    (_input, key) => {
      if (options.length === 0) {
        return;
      }
      if (key.upArrow) {
        setIndex((current) => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setIndex((current) => Math.min(options.length - 1, current + 1));
      } else if (key.return) {
        const selected = options[index];
        if (selected !== undefined) {
          onChange(selected.value);
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
          color={optionIndex === index ? tokyoNight.cyan : tokyoNight.foreground}
        >
          {`${optionIndex === index ? '›' : ' '} ${option.label}`}
        </Text>
      ))}
    </Box>
  );
}
