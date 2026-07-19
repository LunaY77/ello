import { Box, Text } from 'ink';

import { useTheme, type TuiTheme } from '../theme/index.js';

export function DiffBlock({ diff }: { readonly diff: string }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {diff.split('\n').map((line, index) => (
        <Text key={`${index}:${line}`} color={diffLineColor(theme, line)}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function diffLineColor(theme: TuiTheme, line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return theme.diffAdded;
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return theme.diffRemoved;
  }
  return theme.diffContext;
}
