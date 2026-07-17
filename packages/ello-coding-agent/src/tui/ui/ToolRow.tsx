import { Box, Text } from 'ink';

import type { ToolCallView } from '../store/history-entry.js';
import { buildToolCardModel } from '../store/tool-card.js';

import { glyphs } from './glyphs.js';
import { tuiTokens } from './tokens.js';

export function ToolRow({
  call,
  cwd,
  indent = 0,
}: {
  readonly call: ToolCallView;
  readonly cwd: string;
  readonly indent?: number;
}) {
  const model = buildToolCardModel(call, { cwd });
  return (
    <Box marginLeft={indent} gap={1}>
      <Text color={statusColor(call.status)}>{statusGlyph(call.status)}</Text>
      <Text color={statusColor(call.status)}>{model.name}</Text>
      {model.summary !== '' ? (
        <Text color={tuiTokens.color.muted} wrap="truncate-middle">
          {model.summary}
        </Text>
      ) : null}
      {model.metaRight !== '' ? (
        <Text color={tuiTokens.color.muted}>{model.metaRight}</Text>
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

function statusColor(status: ToolCallView['status']): string {
  switch (status) {
    case 'running':
      return tuiTokens.color.warning;
    case 'ok':
      return tuiTokens.color.success;
    case 'fail':
      return tuiTokens.color.danger;
  }
}
