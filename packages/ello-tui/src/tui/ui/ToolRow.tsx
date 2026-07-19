import { Box, Text } from 'ink';

import type { ToolCallView } from '../store/history-entry.js';
import { buildToolCardModel } from '../store/tool-card.js';
import { useTheme, type TuiTheme } from '../theme/index.js';

import { glyphs } from './glyphs.js';

export function ToolRow({
  call,
  cwd,
  indent = 0,
}: {
  readonly call: ToolCallView;
  readonly cwd: string;
  readonly indent?: number;
}) {
  const theme = useTheme();
  const model = buildToolCardModel(call, { cwd });
  return (
    <Box marginLeft={indent} gap={1}>
      <Text color={statusColor(theme, call.status)}>
        {statusGlyph(call.status)}
      </Text>
      <Text color={statusColor(theme, call.status)}>{model.name}</Text>
      {model.summary !== '' ? (
        <Text color={theme.textMuted} wrap="truncate-middle">
          {model.summary}
        </Text>
      ) : null}
      {model.metaRight !== '' ? (
        <Text color={theme.textMuted}>{model.metaRight}</Text>
      ) : null}
    </Box>
  );
}

function statusGlyph(status: ToolCallView['status']): string {
  switch (status) {
    case 'running':
      return glyphs.toolRunning;
    case 'ok':
      return glyphs.toolOk;
    case 'fail':
      return glyphs.toolFail;
  }
}

function statusColor(theme: TuiTheme, status: ToolCallView['status']): string {
  switch (status) {
    case 'running':
      return theme.warning;
    case 'ok':
      return theme.success;
    case 'fail':
      return theme.error;
  }
}
