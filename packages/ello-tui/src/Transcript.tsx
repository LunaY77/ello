import { Box, Text } from 'ink';
import React from 'react';

import type { TranscriptItem } from './state/index.js';

/**
 * Transcript 视口，用于展示最近的用户、assistant、工具和错误输出。
 */
export function Transcript(props: { items: TranscriptItem[] }) {
  return (
    <Box flexDirection="column" minHeight={10}>
      {props.items.slice(-30).map((item) => (
        <Text key={item.id} color={colorForRole(item.role)}>
          {prefixForRole(item.role)}
          {wrapLine(item.text)}
        </Text>
      ))}
    </Box>
  );
}

function colorForRole(role: TranscriptItem['role']): string {
  if (role === 'user') return 'green';
  if (role === 'tool') return 'magenta';
  if (role === 'error') return 'red';
  if (role === 'system') return 'gray';
  return 'white';
}

function prefixForRole(role: TranscriptItem['role']): string {
  if (role === 'user') return '> ';
  if (role === 'tool') return '[tool] ';
  if (role === 'error') return '[error] ';
  if (role === 'system') return '[system] ';
  return '';
}

function wrapLine(value: string): string {
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}
