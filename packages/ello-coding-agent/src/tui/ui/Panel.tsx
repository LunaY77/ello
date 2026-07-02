import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { tuiTokens } from './tokens.js';

export function Panel({
  title,
  children,
  color = tuiTokens.color.border,
}: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly color?: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={color} paddingX={1}>
      {title !== undefined ? <Text color={color}>{title}</Text> : null}
      {children}
    </Box>
  );
}
