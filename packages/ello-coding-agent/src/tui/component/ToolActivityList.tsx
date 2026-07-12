import { Box, Text } from 'ink';
import { useState } from 'react';

import { DiffPreview, presenterFor } from '../presenters/index.js';
import type { ToolCallView } from '../store/history-entry.js';
import { buildToolCardModel } from '../store/tool-card.js';
import { useTheme, type TuiTheme } from '../theme/index.js';

export function ToolActivityList({
  tools,
  indent = 0,
}: {
  readonly tools: readonly ToolCallView[];
  readonly indent?: number;
}) {
  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <Box key={tool.id} marginLeft={indent} marginBottom={1}>
          <ToolCard call={tool} />
        </Box>
      ))}
    </Box>
  );
}

function ToolCard({
  call,
  compact = false,
}: {
  readonly call: ToolCallView;
  readonly compact?: boolean;
}) {
  const theme = useTheme();
  const model = buildToolCardModel(call);
  const presenter = presenterFor(call.name);
  const [collapsed] = useState(() => compact || model.defaultCollapsed);
  const color = statusColor(theme, model.status);

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={color}>{toolStatusLabel(call.status)}</Text>
        <Text color={color}>{model.headline}</Text>
        {model.metaRight !== '' ? (
          <Text color={theme.textMuted}>{model.metaRight}</Text>
        ) : null}
      </Box>
      {model.details.length > 0 ? (
        <Text color={theme.textMuted}>{`  ${model.details.join(' · ')}`}</Text>
      ) : null}
      {model.outputPreview.length > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.textMuted}> └</Text>
          {model.outputPreview.map((line, index) => (
            <Text
              key={`${call.id}:out:${index}`}
              color={theme.textMuted}
              wrap="truncate"
            >
              {`    ${line}`}
            </Text>
          ))}
        </Box>
      ) : null}
      {model.truncationNotice !== undefined ? (
        <Text color={theme.warning}>{`  ${model.truncationNotice}`}</Text>
      ) : null}
      {call.status === 'running' ? (
        <Text color={theme.warning}> working</Text>
      ) : collapsed ? null : model.diff !== undefined ? (
        <DiffPreview
          diff={model.diff}
          file={model.summary}
          {...(model.fileChanges !== undefined
            ? { fileChanges: model.fileChanges }
            : {})}
        />
      ) : call.output !== undefined ? (
        presenter.renderResult(call.input, call.output)
      ) : (
        presenter.renderCall(call.input)
      )}
      {call.status === 'fail' && call.error !== undefined ? (
        <Text color={theme.error}>{call.error.message}</Text>
      ) : null}
    </Box>
  );
}

function statusColor(theme: TuiTheme, status: ToolCallView['status']): string {
  switch (status) {
    case 'running':
      return theme.warning;
    case 'ok':
      return theme.info;
    case 'fail':
      return theme.error;
  }
}

function toolStatusLabel(status: ToolCallView['status']): string {
  switch (status) {
    case 'running':
      return '...';
    case 'ok':
      return 'ok';
    case 'fail':
      return 'x';
  }
}
