/**
 * 本文件负责 thread feature 的“controller”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
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

/**
 * 校验 Thread `controller` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `args`: `parseGoalSlashCommand` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `parseGoalSlashCommand` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Thread `controller` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseGoalSlashCommand(args: readonly string[]): GoalCommand {
  const action = args[0];
  if (
    args.length === 1 &&
    (action === 'status' ||
      action === 'pause' ||
      action === 'resume' ||
      action === 'clear')
  ) {
    return { action };
  }
  if (args.length === 0) throw new Error(goalUsage());
  const tokenFlag = args.indexOf('--tokens');
  if (tokenFlag === -1) {
    return { action: 'create', objective: args.join(' ') };
  }
  if (tokenFlag === 0 || tokenFlag !== args.length - 2) {
    throw new Error(goalUsage());
  }
  const rawTokens = args[tokenFlag + 1];
  if (rawTokens === undefined) {
    throw new Error(goalUsage());
  }
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

/**
 * 执行 Thread `controller` 模块 定义的 `formatGoalStatus` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `goal`: `formatGoalStatus` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `formatGoalStatus` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
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

/**
 * 执行 Thread `controller` 模块 定义的 `goalUsage` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `goalUsage` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function goalUsage(): string {
  return 'Usage: /goal <objective> [--tokens <positive integer>] | status | pause | resume | clear';
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m ${seconds % 60}s`;
}
