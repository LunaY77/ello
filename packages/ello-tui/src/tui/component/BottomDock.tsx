import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { Goal, SessionMode, Usage } from '../../api/protocol-types.js';
import { useTheme, type TuiTheme } from '../theme/index.js';

export interface TuiModeState {
  readonly mode: SessionMode;
}

export function BottomDock({
  profile,
  mode,
  pendingPlanApproval,
  usage,
  goal,
  overlay,
  composer,
}: {
  readonly profile: string;
  readonly mode: TuiModeState;
  readonly pendingPlanApproval: boolean;
  readonly usage?: Usage;
  readonly goal?: Goal;
  readonly overlay: ReactNode;
  readonly composer: ReactNode;
}) {
  const theme = useTheme();
  const tokens =
    usage !== undefined ? usage.inputTokens + usage.outputTokens : 0;
  const cacheLabel =
    usage === undefined || usage.inputTokens === 0
      ? 'cache unavailable'
      : `${Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)}% cached · ${formatTokens(usage.inputTokens - usage.cacheReadTokens)} uncached`;
  return (
    <Box flexDirection="column" marginTop={1}>
      {overlay}
      <Box
        borderStyle="single"
        borderColor={theme.border}
        paddingX={1}
      >
        {composer}
      </Box>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={theme.textMuted}>{profile}</Text>
          <Text color={modeColor(theme, mode.mode)}>
            {modeLabel(mode.mode)}
          </Text>
          {mode.mode === 'plan' ? (
            <Text color={theme.accent}>Shift+Tab to cycle</Text>
          ) : null}
          {pendingPlanApproval ? (
            <Text color={theme.warning}>
              Plan ready · Accept / Chat about this / Deny
            </Text>
          ) : null}
          {goal !== undefined ? (
            <Text color={theme.accent}>{formatGoal(goal)}</Text>
          ) : null}
        </Box>
        <Box gap={1}>
          <Text color={theme.textMuted}>{cacheLabel}</Text>
          <Text color={theme.textMuted}>{`${formatTokens(tokens)} tokens`}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function formatGoal(goal: Goal): string {
  const usage =
    goal.tokenBudget === undefined
      ? formatTokens(goal.tokensUsed)
      : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;
  return `goal ${goal.status} · ${usage}`;
}

function modeColor(theme: TuiTheme, mode: SessionMode): string {
  switch (mode) {
    case 'bypass':
      return theme.error;
    case 'accept-edits':
      return theme.warning;
    case 'plan':
      return theme.accent;
    default:
      return theme.success;
  }
}

function modeLabel(mode: SessionMode): string {
  switch (mode) {
    case 'bypass':
      return 'bypass';
    case 'accept-edits':
      return 'accept-edits';
    case 'plan':
      return 'plan';
    case 'ask-before-changes':
      return 'ask-before-changes';
  }
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
