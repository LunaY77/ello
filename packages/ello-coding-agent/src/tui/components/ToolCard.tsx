import { Box, Text } from 'ink';

import { presenterFor } from '../presenters/index.js';
import type { ToolCallView } from '../state/view-reducer.js';
import { tokyoNight } from '../tokyo-night.js';

/** 工具状态 → 文本颜色。 */
function statusColor(status: ToolCallView['status']): string {
  switch (status) {
    case 'running':
      return tokyoNight.yellow;
    case 'ok':
      return tokyoNight.blue;
    case 'fail':
      return tokyoNight.red;
  }
}

/**
 * 工具卡片。
 *
 * 只做三件事：查 presenter、标状态、把渲染委托给 presenter。
 * 它不认识任何具体工具——加工具不需要改这里。
 */
export function ToolCard({
  call,
  compact = false,
}: {
  readonly call: ToolCallView;
  readonly compact?: boolean;
}) {
  const presenter = presenterFor(call.name);
  const icon =
    call.status === 'running' ? '·' : call.status === 'ok' ? '⎿' : '×';
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={statusColor(call.status)}>{icon}</Text>
        <Text color={tokyoNight.muted}>tool</Text>
        <Text color={statusColor(call.status)}>{call.name}</Text>
        <Text color={tokyoNight.muted}>{presenter.summarize(call.input)}</Text>
      </Box>
      {call.status === 'running' ? (
        <Text color={tokyoNight.yellow}> working</Text>
      ) : compact ? null : call.output !== undefined ? (
        presenter.renderResult(call.input, call.output)
      ) : (
        presenter.renderCall(call.input)
      )}
      {call.status === 'fail' && call.error !== undefined ? (
        <Text color={tokyoNight.red}>{call.error.message}</Text>
      ) : null}
    </Box>
  );
}
