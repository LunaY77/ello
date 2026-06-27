import type { JsonlSessionSummary } from '@ello/coding-agent';
import { Box, Text } from 'ink';
import React from 'react';


/**
 * 渲染会话列表，供会话恢复和分支导航使用。
 */
export function SessionPicker(props: {
  sessions: JsonlSessionSummary[];
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text color="cyan">sessions</Text>
      {props.sessions.length === 0 ? <Text>No sessions.</Text> : null}
      {props.sessions.slice(0, 8).map((session, index) => (
        <Text key={session.sessionId} color={index === props.selectedIndex ? 'yellow' : 'white'}>
          {`${index === props.selectedIndex ? '> ' : '  '}${session.sessionId} ${session.entryCount} entries ${session.updatedAt ?? 'unknown'}`}
        </Text>
      ))}
    </Box>
  );
}
