import { z } from 'zod';

export const GoalStatusSchema = z.enum([
  'active',
  'paused',
  'blocked',
  'complete',
]);

export const GoalStateSchema = z
  .object({
    id: z.string().min(1),
    objective: z.string().trim().min(1).max(4000),
    status: GoalStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    continuationTurns: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().optional(),
    tokensUsed: z.number().int().nonnegative(),
    activeMs: z.number().int().nonnegative(),
    activeSince: z.string().optional(),
    blockerReason: z.string().min(1).optional(),
    blockerFingerprint: z.string().min(1).optional(),
    blockerStreak: z.number().int().nonnegative(),
    pauseReason: z
      .enum(['user', 'token_budget', 'continuation_limit'])
      .optional(),
    completionReason: z.string().min(1).optional(),
    completedAt: z.string().optional(),
  })
  .strict();

export const GoalSessionRecordSchema = z
  .object({
    kind: z.literal('goal-state'),
    goal: GoalStateSchema,
    createdAt: z.string(),
  })
  .strict();

export const GoalClearedRecordSchema = z
  .object({
    kind: z.literal('goal-cleared'),
    goalId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();
