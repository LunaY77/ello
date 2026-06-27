import { Box, Text } from 'ink';
import React from 'react';

import type { TuiState } from '../state/index.js';

/**
 * 为当前会话渲染简洁的设置摘要。
 */
export function SettingsPanel(props: { state: TuiState }) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text color="cyan">settings</Text>
      <Text>{`tools=${Object.keys(props.state.tools).length}`}</Text>
      <Text>{`tasks=${props.state.tasks.length}`}</Text>
    </Box>
  );
}
