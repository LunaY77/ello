import { Box, useStdout } from 'ink';
import React from 'react';

/**
 * TUI 屏幕的顶层布局包装器。
 */
export function AppShell(props: { children: React.ReactNode }) {
  const stdout = useStdout();
  const columns = stdout.stdout?.columns ?? 80;
  return (
    <Box flexDirection="column" paddingX={1} width={columns}>
      {props.children}
    </Box>
  );
}
