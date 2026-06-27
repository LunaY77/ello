import { Box, Text } from 'ink';
import React from 'react';

import type { ToolCard } from '../state/index.js';

import { preview } from './shared.js';

/**
 * 渲染最近的工具调用卡片，并展示紧凑预览。
 */
export function ToolCards(props: { cards: ToolCard[] }) {
  if (props.cards.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text color="cyan">tools</Text>
      {props.cards.slice(-5).map((card) => (
        <Box key={card.toolCallId} flexDirection="column">
          <Text>
            {`${card.toolName} ${card.status}${card.isError ? ' error' : ''}${card.durationMs === undefined ? '' : ` ${card.durationMs}ms`}`}
          </Text>
          <Text>{preview(card.args)}</Text>
          {card.result !== undefined ? <Text>{preview(card.result)}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}
