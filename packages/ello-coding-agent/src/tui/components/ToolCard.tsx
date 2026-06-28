import { Box, Text } from 'ink';

import type { ToolCallView } from '../../product/events.js';

/** 结构化工具卡片。 */
export function ToolCard({ tool, compact = false }: { readonly tool: ToolCallView; readonly compact?: boolean }) {
  const color = tool.status === 'success' ? 'green' : tool.status === 'error' || tool.status === 'denied' ? 'red' : 'yellow';
  const label = `${tool.name}  ${tool.status}${tool.durationMs !== undefined ? `  ${tool.durationMs}ms` : ''}`;
  if (compact) {
    return <Text color={color}>{`tool ${tool.name}  ${tool.status}  ${tool.summary}`}</Text>;
  }
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text color={color}>{label}</Text>
        {tool.render?.target ? <Text dimColor>{tool.render.target}</Text> : <Text dimColor>{tool.render?.kind ?? 'generic'}</Text>}
      </Box>
      <Text wrap="truncate-middle">{tool.summary}</Text>
      {tool.argsPreview ? <Text dimColor wrap="wrap">{`args   ${tool.argsPreview}`}</Text> : null}
      {tool.render?.kind === 'diff' && tool.render.diff ? (
        <Text wrap="wrap">{`diff\n${tool.render.diff}`}</Text>
      ) : null}
      {tool.render?.kind === 'bash' ? (
        <>
          <Text>{`exit   ${tool.render.exitCode ?? '-'}`}</Text>
          {tool.render.stdout ? <Text wrap="wrap">{`stdout\n${tool.render.stdout}`}</Text> : null}
          {tool.render.stderr
            ? tool.render.exitCode === 0
              ? <Text wrap="wrap">{`stderr\n${tool.render.stderr}`}</Text>
              : <Text color="red" wrap="wrap">{`stderr\n${tool.render.stderr}`}</Text>
            : null}
        </>
      ) : null}
      {tool.render?.kind !== 'diff' && tool.render?.kind !== 'bash' && tool.outputPreview ? <Text wrap="wrap">{tool.outputPreview}</Text> : null}
      {tool.render?.truncated ? <Text color="yellow">output truncated</Text> : null}
      {tool.error ? <Text color="red" wrap="wrap">{tool.error}</Text> : null}
    </Box>
  );
}
