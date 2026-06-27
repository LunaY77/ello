import type { CodingAgentConfig } from '@ello/coding-agent';
import { Box, Text } from 'ink';
import React from 'react';


import type { TuiState } from '../state/index.js';

import { countTasks, preview } from './shared.js';

/**
 * 底部状态栏，展示最关键的 runtime 信息。
 */
export function StatusBar(props: { state: TuiState; config: CodingAgentConfig }) {
  const taskCounts = countTasks(props.state.tasks);
  return (
    <Box borderStyle="single" paddingX={1} flexDirection="column">
      <Text>
        <Text color={props.state.status === 'error' ? 'red' : 'cyan'}>{props.state.status}</Text>
        {` model=${props.state.model} session=${props.state.sessionId.slice(0, 8)}${props.state.exitPending ? ' exit?' : ''}`}
      </Text>
      <Text>{`cwd=${props.config.cwd} tasks=${taskCounts}`}</Text>
      <Text>
        {`run=${
          props.state.currentRun
            ? `${props.state.currentRun.runId}:${preview(props.state.currentRun.input)}`
            : 'idle'
        }`}
      </Text>
      <Text>{`${props.state.usageText} ${props.state.usageTotals}`}</Text>
    </Box>
  );
}
