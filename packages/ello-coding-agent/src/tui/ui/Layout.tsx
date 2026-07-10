import { Box } from 'ink';
import type { ReactNode } from 'react';

export function Row({ children }: { readonly children: ReactNode }) {
  return <Box flexDirection="row">{children}</Box>;
}

export function Column({ children }: { readonly children: ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}

export function DockFrame({ children }: { readonly children: ReactNode }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {children}
    </Box>
  );
}
