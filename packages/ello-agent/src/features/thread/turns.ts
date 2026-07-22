/**
 * 本文件负责 thread feature 的“turns”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createEntityId } from '../../ids.js';
import {
  AppServerError,
  type ThreadSnapshot,
  type Turn,
  type UserInput,
} from '../../protocol/v1/index.js';
import type {
  NewThreadRecord,
  ThreadRecord,
} from '../../storage/threads/thread-record.js';
import type { AgentMessage } from '../agent/engine/index.js';
import type {
  AgentFeature,
  AgentInteraction,
  PermissionSessionView,
  AgentRunGoal,
  AgentRun,
} from '../agent/index.js';

import type { CompactionEntry } from './compact.js';
import type { createThreadInteractions } from './interactions.js';
import { consumeAgentRun } from './run-records.js';

interface ActiveTurn {
  readonly id: string;
  readonly run: AgentRun;
  readonly driveTask: Promise<void>;
}

interface CreateTurnOperationsInput {
  readonly threadId: string;
  readonly startAgentRun: AgentFeature['startRun'];
  readonly permission: PermissionSessionView;
  /**
   * 执行 Thread turn 编排 模块 定义的 `history` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  history(): ReadonlyArray<AgentMessage>;
  /**
   * 在 Thread turn 编排 模块 中执行 `compactionEntries` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  compactionEntries(): ReadonlyArray<CompactionEntry>;
  /**
   * 在 Thread turn 编排 模块 中执行 `prepareRun` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Thread turn 编排 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  prepareRun(): Promise<void>;
  readonly interactions: ReturnType<typeof createThreadInteractions>;
  /**
   * 读取 Thread turn 编排 模块 的 `snapshot` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `snapshot` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  snapshot(): ThreadSnapshot;
  /**
   * 按 Thread turn 编排 模块 的一致性约束执行 `append` 状态变更。
   *
   * Args:
   * - `record`: 要由 `append` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 Thread turn 编排 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread turn 编排 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  append(record: NewThreadRecord): Promise<ThreadRecord>;
  /**
   * 在 Thread turn 编排 模块 中执行 `enqueue` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `operation`: `enqueue` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Thread turn 编排 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * 校验 Thread turn 编排 模块 的输入并返回已满足领域约束的值。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Thread turn 编排 模块 的同步状态变更完成后返回，不产生业务结果。
   *
   * Throws:
   * - 当 Thread turn 编排 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  assertOpen(): void;
  /**
   * 处理 Thread turn 编排 模块 的 `onCompleted` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Thread turn 编排 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  onCompleted(): void;
}

export interface TurnOperations {
  /**
   * 执行 Thread turn 编排 模块 定义的 `hasActiveTurn` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   */
  hasActiveTurn(): boolean;
  /**
   * 在 Thread turn 编排 模块 中执行 `start` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `input`: `start` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `settings`: `start` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在 Thread turn 编排 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread turn 编排 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  start(
    input: ReadonlyArray<UserInput>,
    settings?: TurnSettings,
  ): Promise<Turn>;
  /**
   * 把新的输入按既定顺序加入 Thread turn 编排 模块 的待处理队列。
   *
   * Args:
   * - `turnId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `input`: `steer` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   *
   * Returns:
   * - Promise 在 Thread turn 编排 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  steer(turnId: string, input: ReadonlyArray<UserInput>): Promise<void>;
  /**
   * 中止 Thread turn 编排 模块 中正在进行的工作，并保留调用方提供的终止原因。
   *
   * Args:
   * - `turnId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `reason`: 可观察的终止或拒绝原因；会随失败状态向上游传播。
   *
   * Returns:
   * - Promise 在 Thread turn 编排 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  interrupt(turnId: string, reason: string): Promise<Turn>;
  /**
   * 在 Thread turn 编排 模块 中执行 `resolveServerRequest` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `requestId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `result`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
   *
   * Returns:
   * - Promise 在 Thread turn 编排 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 Thread turn 编排 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  resolveServerRequest(requestId: string, result: unknown): Promise<void>;
  /**
   * 执行 Thread turn 编排 模块 定义的 `rejectServerRequest` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `requestId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   * - `error`: 上游捕获的失败值；函数保留原始 cause 并转换为当前错误契约。
   *
   * Returns:
   * - Promise 在 Thread turn 编排 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  rejectServerRequest(
    requestId: string,
    error: { readonly code: number; readonly message: string },
  ): Promise<void>;
  /**
   * 停止 Thread turn 编排 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 当 Thread turn 编排 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  close(): Promise<void>;
}

export interface TurnSettings {
  readonly model?: string;
  readonly profile?: string;
  readonly mode?: ThreadSnapshot['settings']['mode'];
}

/**
 * 创建固定 Thread 的 turn 操作闭包。
 *
 * Args:
 * - `options`: Thread 的串行 mutation、持久化、交互、权限与 Agent 启动能力。
 *
 * Returns:
 * - 返回共享同一 `activeTurn` 的 start、steer、interrupt、request resolution 与 close 操作。
 */
export function createTurnOperations(
  options: CreateTurnOperationsInput,
): TurnOperations {
  let activeTurn: ActiveTurn | undefined;
  const recorderOptions = {
    snapshot: options.snapshot,
    compactionEntries: options.compactionEntries,
    append: options.append,
    enqueue: options.enqueue,
    onFinished: (turnId: string, completed: boolean) => {
      if (activeTurn?.id === turnId) activeTurn = undefined;
      if (completed) options.onCompleted();
    },
    registerInteraction: (
      turn: Turn,
      interaction: AgentInteraction,
      run: AgentRun,
    ) => options.interactions.register(turn, interaction, run),
  };

  const start = (
    input: ReadonlyArray<UserInput>,
    settings: TurnSettings | undefined,
  ): Promise<Turn> =>
    options.enqueue(async () => {
      options.assertOpen();
      if (activeTurn !== undefined) {
        throw new AppServerError({
          type: 'threadBusy',
          message: `Thread ${options.threadId} already has an active turn.`,
        });
      }
      if (input.length === 0) {
        throw new AppServerError({
          type: 'invalidParams',
          message: 'turn/start requires at least one input.',
        });
      }
      await applySettings(options, settings);
      await ensurePreview(options, input);
      const turn: Turn = {
        id: createEntityId('turn'),
        threadId: options.threadId,
        status: 'inProgress',
        items: [],
        startedAt: new Date().toISOString(),
      };
      const goal = options.snapshot().goal;
      const activeGoalId = goal?.status === 'active' ? goal.id : undefined;
      await options.append({ kind: 'turn.started', turn });
      await options.append({
        kind: 'thread.status',
        status: 'running',
        activeFlags: ['turn'],
      });
      await appendUserItems(options, turn, input);
      // usage 只归属 turn 启动时的 active Goal，执行期间替换 Goal 不得串账。
      let run: AgentRun;
      try {
        await options.prepareRun();
        const snapshot = options.snapshot();
        run = await options.startAgentRun({
          threadId: options.threadId,
          turnId: turn.id,
          cwd: snapshot.thread.cwd,
          selection: snapshot.settings,
          history: options.history(),
          input: input.map(formatUserInput).join('\n'),
          goal: agentRunGoal(snapshot.goal),
          permission: options.permission,
        });
      } catch (error) {
        await options.append({
          kind: 'turn.failed',
          turn: {
            ...turn,
            status: 'failed',
            completedAt: new Date().toISOString(),
            errorCode: 'EXECUTOR_START_FAILED',
          },
          error: {
            code: 'EXECUTOR_START_FAILED',
            message: errorMessage(error),
          },
        });
        await options.append({
          kind: 'thread.status',
          status: 'failed',
          activeFlags: [],
        });
        throw error;
      }
      const driveTask = consumeAgentRun(
        recorderOptions,
        turn,
        run,
        activeGoalId,
      );
      activeTurn = { id: turn.id, run, driveTask };
      // start 通过持久化终态观察结果；interrupt/close 仍会等待原 Promise 并收到同一 rejection。
      void driveTask.then(undefined, () => undefined);
      return turn;
    });

  const steer = (
    turnId: string,
    input: ReadonlyArray<UserInput>,
  ): Promise<void> =>
    options.enqueue(async () => {
      requireActiveTurn(activeTurn, turnId).run.steer(
        input.map(formatUserInput).join('\n'),
      );
    });

  const interrupt = async (turnId: string, reason: string): Promise<Turn> => {
    const activeToWait = await options.enqueue(async () => {
      const active = activeTurn;
      if (active === undefined) {
        const turn = findTurn(options, turnId);
        if (turn.status === 'inProgress') {
          throw new AppServerError({
            type: 'turnMismatch',
            message: `Turn ${turnId} is not active in this runtime.`,
          });
        }
        return undefined;
      }
      if (active.id !== turnId) throw turnMismatch(turnId, active.id);
      active.run.interrupt(reason);
      return active;
    });
    if (activeToWait !== undefined) await activeToWait.driveTask;
    return findTurn(options, turnId);
  };

  const resolveServerRequest = (
    requestId: string,
    result: unknown,
  ): Promise<void> =>
    options.enqueue(async () => {
      requirePendingRequest(options, activeTurn, requestId);
      await options.interactions.resolve(requestId, result);
    });

  const rejectServerRequest = (
    requestId: string,
    error: { readonly code: number; readonly message: string },
  ): Promise<void> =>
    options.enqueue(async () => {
      requirePendingRequest(options, activeTurn, requestId);
      await options.interactions.reject(requestId, error);
    });

  const close = async (): Promise<void> => {
    const active = activeTurn;
    if (active === undefined) return;
    active.run.interrupt('thread runtime closing');
    await active.driveTask;
  };

  return {
    hasActiveTurn: () => activeTurn !== undefined,
    start,
    steer,
    interrupt,
    resolveServerRequest,
    rejectServerRequest,
    close,
  };
}

async function applySettings(
  input: CreateTurnOperationsInput,
  settings: TurnSettings | undefined,
): Promise<void> {
  if (settings === undefined) return;
  if (
    settings.model === undefined &&
    settings.profile === undefined &&
    settings.mode === undefined
  ) {
    return;
  }
  const snapshot = input.snapshot();
  await input.append({
    kind: 'thread.metadata',
    settings: {
      ...snapshot.settings,
      ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(settings.profile === undefined ? {} : { profile: settings.profile }),
      ...(settings.mode === undefined ? {} : { mode: settings.mode }),
    },
  });
}

async function ensurePreview(
  options: CreateTurnOperationsInput,
  userInput: ReadonlyArray<UserInput>,
): Promise<void> {
  if (options.snapshot().thread.preview.trim() !== '') return;
  const preview = threadPreview(userInput);
  if (preview !== '') {
    await options.append({ kind: 'thread.metadata', preview });
  }
}

async function appendUserItems(
  options: CreateTurnOperationsInput,
  turn: Turn,
  input: ReadonlyArray<UserInput>,
): Promise<void> {
  for (const userInput of input) {
    const item = {
      type: 'userMessage' as const,
      id: createEntityId('item'),
      turnId: turn.id,
      createdAt: new Date().toISOString(),
      text: formatUserInput(userInput),
    };
    await options.append({
      kind: 'item.started',
      turnId: turn.id,
      item,
    });
    await options.append({
      kind: 'item.completed',
      turnId: turn.id,
      item,
    });
  }
}

function requireActiveTurn(
  active: ActiveTurn | undefined,
  turnId: string,
): ActiveTurn {
  if (active === undefined || active.id !== turnId) {
    throw turnMismatch(turnId, active?.id);
  }
  return active;
}

function requirePendingRequest(
  options: CreateTurnOperationsInput,
  active: ActiveTurn | undefined,
  requestId: string,
): void {
  const request = options
    .snapshot()
    .pendingServerRequests.find((candidate) => candidate.id === requestId);
  if (request === undefined) {
    throw new AppServerError({
      type: 'requestResolved',
      message: `Server Request ${requestId} is not pending.`,
    });
  }
  if (active === undefined) {
    throw new AppServerError({
      type: 'turnMismatch',
      message: `Server Request ${requestId} has no active turn.`,
    });
  }
}

function findTurn(options: CreateTurnOperationsInput, turnId: string): Turn {
  const turn = options
    .snapshot()
    .turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) {
    throw new AppServerError({
      type: 'turnMismatch',
      message: `Turn ${turnId} does not belong to thread ${options.threadId}.`,
    });
  }
  return turn;
}

function turnMismatch(expected: string, active: string | undefined) {
  return new AppServerError({
    type: 'turnMismatch',
    message: `Expected turn ${expected}, active turn is ${active ?? 'none'}.`,
    details: { expectedTurnId: expected, activeTurnId: active ?? null },
  });
}

function formatUserInput(input: UserInput): string {
  switch (input.type) {
    case 'text':
      return input.text;
    case 'file':
      return `@${input.path}`;
    case 'image':
      return `[image ${input.artifactId}]`;
  }
}

function threadPreview(input: readonly UserInput[]): string {
  const preferred = input.find(
    (entry): entry is Extract<UserInput, { type: 'text' }> =>
      entry.type === 'text' && entry.text.trim() !== '',
  );
  return (
    preferred === undefined
      ? input.map(formatUserInput).join(' ')
      : preferred.text
  )
    .trim()
    .replace(/\s+/gu, ' ')
    .slice(0, 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentRunGoal(goal: ThreadSnapshot['goal']): AgentRunGoal | null {
  if (goal === null) return null;
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.tokenBudget === undefined
      ? {}
      : { tokenBudget: goal.tokenBudget }),
  };
}
