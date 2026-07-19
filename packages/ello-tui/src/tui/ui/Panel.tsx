import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { useTheme } from '../theme/index.js';

export function Panel({
  title,
  children,
  color,
}: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly color?: string;
}) {
  const theme = useTheme();
  const panelColor = color ?? theme.border;
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={panelColor}
      paddingX={1}
    >
      {title !== undefined ? <Text color={panelColor}>{title}</Text> : null}
      {children}
    </Box>
  );
}
