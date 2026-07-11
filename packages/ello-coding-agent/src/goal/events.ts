import type { GoalState } from './types.js';

export type GoalEvent =
  | { readonly type: 'goal.created'; readonly goal: GoalState }
  | { readonly type: 'goal.updated'; readonly goal: GoalState }
  | { readonly type: 'goal.continuation.started'; readonly goal: GoalState }
  | { readonly type: 'goal.continuation.completed'; readonly goal: GoalState }
  | { readonly type: 'goal.paused'; readonly goal: GoalState }
  | { readonly type: 'goal.completed'; readonly goal: GoalState }
  | { readonly type: 'goal.blocked'; readonly goal: GoalState }
  | { readonly type: 'goal.cleared'; readonly goalId: string };
