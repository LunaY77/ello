import { access } from 'node:fs/promises';
import path from 'node:path';

import { Command, InvalidArgumentError } from 'commander';

import { formatGoalStatus } from '../../goal/index.js';
import type { CodingSession } from '../../runtime/coding-session.js';
import type { CliCommandModule } from '../types.js';

interface GoalCliOptions {
  readonly tokens?: number;
  readonly session?: string;
}

const MANAGEMENT_ACTIONS = ['status', 'pause', 'resume', 'clear'] as const;
type GoalManagementAction = (typeof MANAGEMENT_ACTIONS)[number];

export const goalCommands: CliCommandModule = {
  register(program, ctx) {
    program
      .command('goal')
      .description('create or manage a session goal')
      .argument(
        '<objective-or-action...>',
        'objective, status, pause, resume, or clear',
      )
      .option('--tokens <count>', 'positive token budget', parsePositiveInteger)
      .option('--session <id>', 'existing session id')
      .action(
        async (parts: string[], options: GoalCliOptions, command: Command) => {
          const action = managementAction(parts);
          if (action !== null && options.tokens !== undefined) {
            throw new Error('--tokens is only valid when creating a goal.');
          }
          if (action !== null && options.session === undefined) {
            throw new Error(`ello goal ${action} requires --session <id>.`);
          }
          const config = await ctx.resolveConfig(command.optsWithGlobals());
          if (options.session !== undefined) {
            await requireSession(config.sessionDir, options.session);
          }
          const { createCodingSession } =
            await import('../../runtime/coding-session.js');
          const { renderEvent } = await import('../render.js');
          const session = await createCodingSession({
            config: {
              ...config,
              sessionId: options.session ?? null,
            },
          });
          const unsubscribe = session.subscribe((event) => {
            ctx.io.stdout.write(renderEvent(event, config.json));
          });
          try {
            await executeGoalCommand(session, action, parts, options.tokens);
            const status = session.goalStatus();
            ctx.io.stdout.write(
              `${config.json ? JSON.stringify(status, null, 2) : formatGoalStatus(status)}\n`,
            );
          } finally {
            unsubscribe();
            await session.close();
          }
        },
      );
  },
};

async function executeGoalCommand(
  session: CodingSession,
  action: GoalManagementAction | null,
  parts: readonly string[],
  tokenBudget?: number,
): Promise<void> {
  switch (action) {
    case 'status':
      return;
    case 'pause':
      await session.pauseGoal();
      return;
    case 'resume':
      await session.resumeGoal();
      await session.waitForGoalContinuation();
      return;
    case 'clear':
      await session.clearGoal();
      return;
    case null:
      await session.createGoal(parts.join(' '), tokenBudget);
      await session.waitForGoalContinuation();
      return;
  }
}

function managementAction(
  parts: readonly string[],
): GoalManagementAction | null {
  if (parts.length !== 1) return null;
  const value = parts[0]!;
  return MANAGEMENT_ACTIONS.find((action) => action === value) ?? null;
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError('token budget must be a positive integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('token budget must be a positive integer');
  }
  return parsed;
}

async function requireSession(
  sessionDir: string,
  sessionId: string,
): Promise<void> {
  try {
    await access(path.join(sessionDir, `${sessionId}.jsonl`));
  } catch (error) {
    throw new Error(`Unknown session: ${sessionId}`, { cause: error });
  }
}
