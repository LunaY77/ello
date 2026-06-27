import { Box, Text } from 'ink';
import React from 'react';

/**
 * 当 prompt 以 `/` 开头时渲染 slash command 建议。
 */
export function CommandPalette(props: { suggestions?: string[]; title?: string }) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text color="cyan">{props.title ?? 'commands'}</Text>
      <Text>
        {(props.suggestions ?? [
          '/help',
          '/model',
          '/resume',
          '/new',
          '/compact',
          '/tools',
          '/config',
          '/memory',
          '/permissions',
          '/tasks',
          '/exit',
        ]).join(' ')}
      </Text>
    </Box>
  );
}
