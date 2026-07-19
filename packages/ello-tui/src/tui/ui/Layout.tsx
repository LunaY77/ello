import { Box } from 'ink';
import type { ReactNode } from 'react';

import { useTheme } from '../theme/index.js';

export function Row({ children }: { readonly children: ReactNode }) {
  return <Box flexDirection="row">{children}</Box>;
}

export function Column({ children }: { readonly children: ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}

export function DockFrame({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
    >
      {children}
    </Box>
  );
}
