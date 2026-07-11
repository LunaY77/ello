import type { AgentUsage } from '@ello/agent';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { GoalState } from '../../goal/types.js';
import { tuiTokens } from '../ui/tokens.js';

export function BottomDock({
  profile,
  approvalMode,
  usage,
  goal,
  overlay,
  composer,
}: {
  readonly profile: string;
  readonly approvalMode: string;
  readonly usage?: AgentUsage;
  readonly goal?: GoalState;
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
          <Text color={approvalColor(approvalMode)}>{approvalMode}</Text>
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

function formatGoal(goal: GoalState): string {
  const usage =
    goal.tokenBudget === undefined
      ? formatTokens(goal.tokensUsed)
      : `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;
  return `goal ${goal.status} · turn ${goal.continuationTurns} · ${usage}`;
}

function approvalColor(mode: string): string {
  switch (mode) {
    case 'bypass':
      return tuiTokens.color.danger;
    case 'accept-edits':
      return tuiTokens.color.warning;
    case 'dont-ask':
      return tuiTokens.color.accent;
    default:
      return tuiTokens.color.success;
  }
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
