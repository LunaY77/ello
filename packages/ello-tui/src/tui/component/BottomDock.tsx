import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { Goal, SessionMode, Usage } from '../../api/protocol-types.js';
import { tuiTokens } from '../ui/tokens.js';

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
        borderColor={tuiTokens.color.border}
        paddingX={1}
      >
        {composer}
      </Box>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={tuiTokens.color.muted}>{profile}</Text>
          <Text color={modeColor(mode.mode)}>{modeLabel(mode.mode)}</Text>
          {mode.mode === 'plan' ? (
            <Text color={tuiTokens.color.accent}>Shift+Tab to cycle</Text>
          ) : null}
          {pendingPlanApproval ? (
            <Text color={tuiTokens.color.warning}>
              Plan ready · Accept / Chat about this / Deny
            </Text>
          ) : null}
          {goal !== undefined ? (
            <Text color={tuiTokens.color.accent}>{formatGoal(goal)}</Text>
          ) : null}
        </Box>
        <Box gap={1}>
          <Text color={tuiTokens.color.muted}>{cacheLabel}</Text>
          <Text
            color={tuiTokens.color.muted}
          >{`${formatTokens(tokens)} tokens`}</Text>
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

function modeColor(mode: SessionMode): string {
  switch (mode) {
    case 'bypass':
      return tuiTokens.color.danger;
    case 'accept-edits':
      return tuiTokens.color.warning;
    case 'plan':
      return tuiTokens.color.accent;
    default:
      return tuiTokens.color.success;
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
