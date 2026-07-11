import type { JsonlSessionRepository } from '../session/repository.js';

import type { GoalState } from './types.js';

export interface GoalSessionPort {
  load(): Promise<GoalState | null>;
  save(goal: GoalState): Promise<void>;
  clear(goalId: string): Promise<void>;
}

export function createGoalSessionPort(options: {
  readonly repository: JsonlSessionRepository;
  readonly sessionId: () => string;
}): GoalSessionPort {
  return {
    async load() {
      await options.repository.open(options.sessionId());
      return options.repository.latestGoal(options.sessionId());
    },
    async save(goal) {
      await options.repository.open(options.sessionId());
      await options.repository.appendGoalState(options.sessionId(), goal);
    },
    async clear(goalId) {
      await options.repository.appendGoalCleared(options.sessionId(), goalId);
    },
  };
}
