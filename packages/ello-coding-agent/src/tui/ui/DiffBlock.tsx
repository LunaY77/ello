import { Box, Text } from 'ink';

import { tuiTokens } from './tokens.js';

export function DiffBlock({ diff }: { readonly diff: string }) {
  return (
    <Box flexDirection="column">
      {diff.split('\n').map((line, index) => (
        <Text key={`${index}:${line}`} color={diffLineColor(line)}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function diffLineColor(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return tuiTokens.color.diffAdd;
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return tuiTokens.color.diffRemove;
  }
  return tuiTokens.color.muted;
}
