import type { GoalStatusView } from './types.js';

export type GoalCommand =
  | {
      readonly action: 'create';
      readonly objective: string;
      readonly tokens?: number;
    }
  | { readonly action: 'status' }
  | { readonly action: 'pause' }
  | { readonly action: 'resume' }
  | { readonly action: 'clear' };

export function parseGoalSlashCommand(args: readonly string[]): GoalCommand {
  if (
    args.length === 1 &&
    ['status', 'pause', 'resume', 'clear'].includes(args[0]!)
  ) {
    return { action: args[0] as 'status' | 'pause' | 'resume' | 'clear' };
  }
  if (args.length === 0) throw new Error(goalUsage());
  const tokenFlag = args.indexOf('--tokens');
  if (tokenFlag === -1) {
    return { action: 'create', objective: args.join(' ') };
  }
  if (tokenFlag === 0 || tokenFlag !== args.length - 2) {
    throw new Error(goalUsage());
  }
  const rawTokens = args[tokenFlag + 1]!;
  if (!/^\d+$/u.test(rawTokens)) {
    throw new Error('Goal token budget must be a positive integer.');
  }
  const tokens = Number(rawTokens);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new Error('Goal token budget must be a positive integer.');
  }
  return {
    action: 'create',
    objective: args.slice(0, tokenFlag).join(' '),
    tokens,
  };
}

export function formatGoalStatus(goal: GoalStatusView | null): string {
  if (goal === null) return 'No goal exists for this session.';
  const budget =
    goal.tokenBudget === undefined
      ? `${goal.tokensUsed}`
      : `${goal.tokensUsed}/${goal.tokenBudget} (${goal.remainingTokens} remaining)`;
  return [
    `objective: ${goal.objective}`,
    `status: ${goal.status}`,
    `continuation turns: ${goal.continuationTurns}`,
    `tokens: ${budget}`,
    `active elapsed: ${formatElapsed(goal.activeElapsedMs)}`,
    `blocker streak: ${goal.blockerStreak}`,
    ...(goal.blockerReason !== undefined
      ? [`blocker reason: ${goal.blockerReason}`]
      : []),
    ...(goal.pauseReason !== undefined
      ? [`pause reason: ${goal.pauseReason}`]
      : []),
  ].join('\n');
}

export function goalUsage(): string {
  return 'Usage: /goal <objective> [--tokens <positive integer>] | status | pause | resume | clear';
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m ${seconds % 60}s`;
}
