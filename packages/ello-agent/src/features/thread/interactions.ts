/**
 * Thread 交互边界负责把 Agent 暂停事实投影为 Server Request，并把 Client 结果恢复到同一次运行。
 *
 * 本文件拥有进程内 pending interaction 映射。任何结果校验失败都必须先持久化 rejected resolution，
 * 再拒绝对应 Agent interaction，确保 pending request、Agent run 与 Thread 终态同步结束。
 */
import { createEntityId } from '../../ids.js';
import {
  APP_SERVER_ERROR_CODES,
  AppServerError,
  ApprovalDecisionSchema,
  type ApprovalDecision,
  type PendingServerRequest,
  type ThreadSnapshot,
  type Turn,
  invalidParams,
} from '../../protocol/v1/index.js';
import type {
  NewThreadRecord,
  ThreadRecord,
} from '../../storage/threads/thread-record.js';
import type { AgentInteraction, AgentRun } from '../agent/index.js';
import { PLAN_EXIT_TOOL_NAME } from '../agent/index.js';
import {
  REQUEST_USER_INPUT_TOOL_NAME,
  UserInputRequestSchema,
  validateUserInputResolution,
} from '../agent/index.js';
import { projectApprovalItem, type RulesStore } from '../tool/index.js';

import { readPlanArtifact } from './plan.js';

interface PendingInteraction {
  readonly interaction: AgentInteraction;
  readonly run: AgentRun;
}

interface ThreadInteractionsOptions {
  readonly rules: RulesStore;
  readonly externalPaths: Set<string>;
  /**
   * 读取 Thread 交互 模块 的 `snapshot` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `snapshot` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  snapshot(): ThreadSnapshot;
  /**
   * 按 Thread 交互 模块 的一致性约束执行 `append` 状态变更。
   *
   * Args:
   * - `record`: 要由 `append` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - Promise 在 Thread 交互 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Thread 交互 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  append(record: NewThreadRecord): Promise<ThreadRecord>;
}

/**
 * 创建单个已加载 Thread 的交互控制器。
 *
 * Args:
 * - `options`: 提供动态 permission 状态、当前 Thread 投影和串行持久化入口；这些资源由 Thread 拥有。
 *
 * Returns:
 * - 返回注册、解决和拒绝交互的函数集合；集合与当前 Thread 生命周期一致。
 */
export function createThreadInteractions(options: ThreadInteractionsOptions) {
  const pending = new Map<string, PendingInteraction>();

  const register = async (
    turn: Turn,
    interaction: AgentInteraction,
    run: AgentRun,
  ): Promise<void> => {
    const requestId = createEntityId('srvreq');
    const request = await projectRequest(options, requestId, turn, interaction);
    pending.set(requestId, { interaction, run });
    try {
      await options.append({ kind: 'serverRequest.created', request });
    } catch (error) {
      pending.delete(requestId);
      throw error;
    }
  };

  const resolve = async (requestId: string, result: unknown): Promise<void> => {
    const entry = requirePending(options.snapshot(), pending, requestId);
    try {
      switch (entry.interaction.type) {
        case 'approval':
          await resolveApproval(options, entry.interaction, entry.run, result);
          break;
        case 'toolResult':
          await resolveToolResult(
            options,
            entry.interaction,
            entry.run,
            result,
          );
          break;
        default:
          entry.interaction satisfies never;
          throw new Error('Unhandled Thread interaction.');
      }
    } catch (error) {
      entry.run.resume({
        type: 'rejected',
        interactionId: entry.interaction.interactionId,
        error: interactionError(error),
      });
      await appendResolution(options, requestId, 'rejected');
      pending.delete(requestId);
      return;
    }
    await appendResolution(options, requestId, 'resolved');
    pending.delete(requestId);
  };

  const reject = async (
    requestId: string,
    error: { readonly code: number; readonly message: string },
  ): Promise<void> => {
    const entry = requirePending(options.snapshot(), pending, requestId);
    entry.run.resume({
      type: 'rejected',
      interactionId: entry.interaction.interactionId,
      error,
    });
    await appendResolution(options, requestId, 'rejected');
    pending.delete(requestId);
  };

  return { register, resolve, reject };
}

async function projectRequest(
  options: ThreadInteractionsOptions,
  requestId: string,
  turn: Turn,
  interaction: AgentInteraction,
): Promise<PendingServerRequest> {
  if (interaction.type === 'approval') {
    const projected = projectApprovalItem(interaction.item);
    const metadata = readRecord(projected.metadata, 'Approval metadata');
    const requestMetadata = readRecord(
      metadata.request,
      'Approval request metadata',
    );
    const method = approvalMethod(projected.toolName, requestMetadata);
    const base = {
      threadId: turn.threadId,
      turnId: turn.id,
      itemId: projected.toolCallId,
      reason:
        projected.reason ?? readString(metadata.reason) ?? 'Approval required.',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    } as const;
    const params =
      method === 'item/commandExecution/requestApproval'
        ? {
            ...base,
            command: [
              requireString(requestMetadata.command, 'Approval command'),
            ],
            cwd: requireString(requestMetadata.cwd, 'Approval cwd'),
          }
        : method === 'item/fileChange/requestApproval'
          ? {
              ...base,
              paths: readStringArray(metadata.patterns, 'Approval paths'),
              summary: projected.reason ?? `Run ${projected.toolName}`,
            }
          : {
              ...base,
              permission: requireString(
                metadata.permission,
                'Approval permission',
              ),
              scope: 'session',
            };
    return {
      id: requestId,
      method,
      threadId: turn.threadId,
      turnId: turn.id,
      itemId: projected.toolCallId,
      params,
      createdAt: interaction.occurredAt,
    };
  }

  if (interaction.item.toolName === REQUEST_USER_INPUT_TOOL_NAME) {
    const input = UserInputRequestSchema.parse(interaction.item.input);
    return {
      id: requestId,
      method: 'item/tool/requestUserInput',
      threadId: turn.threadId,
      turnId: turn.id,
      itemId: interaction.item.toolCallId,
      params: {
        threadId: turn.threadId,
        turnId: turn.id,
        itemId: interaction.item.toolCallId,
        reason: 'The agent needs user input to continue.',
        questions: input.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          multiple: question.multiSelect,
          options: question.options,
        })),
      },
      createdAt: interaction.occurredAt,
    };
  }
  if (interaction.item.toolName !== PLAN_EXIT_TOOL_NAME) {
    throw new Error(`Unsupported deferred tool: ${interaction.item.toolName}`);
  }
  const plan = options.snapshot().plan;
  if (plan === null) {
    throw new Error('Plan approval requested before a plan exists.');
  }
  const awaitingApproval = {
    ...plan,
    status: 'awaitingApproval' as const,
    updatedAt: new Date().toISOString(),
  };
  await options.append({ kind: 'plan.state', plan: awaitingApproval });
  return {
    id: requestId,
    method: 'item/plan/requestApproval',
    threadId: turn.threadId,
    turnId: turn.id,
    itemId: interaction.item.toolCallId,
    params: {
      threadId: turn.threadId,
      turnId: turn.id,
      itemId: interaction.item.toolCallId,
      reason: 'Approve the current plan.',
      availableDecisions: ['accept', 'decline', 'cancel'],
      contentHash: awaitingApproval.contentHash,
      preview: awaitingApproval.content.slice(0, 4_000),
    },
    createdAt: interaction.occurredAt,
  };
}

async function resolveApproval(
  options: ThreadInteractionsOptions,
  interaction: Extract<AgentInteraction, { type: 'approval' }>,
  run: AgentRun,
  result: unknown,
): Promise<void> {
  const decision = ApprovalDecisionSchema.parse(result);
  if (decision.decision === 'acceptForSession') {
    await options.rules.addAllowRule(interaction.item, 'session');
  }
  if (isAccepted(decision)) {
    for (const externalDir of approvalExternalDirs(interaction.item)) {
      options.externalPaths.add(externalDir);
    }
  }
  run.resume({
    type: 'approval',
    interactionId: interaction.interactionId,
    approved: isAccepted(decision),
    ...(decision.decision === 'decline'
      ? { reason: 'Declined by client.' }
      : decision.decision === 'cancel'
        ? { reason: 'Cancelled by client.' }
        : {}),
  });
}

async function resolveToolResult(
  options: ThreadInteractionsOptions,
  interaction: Extract<AgentInteraction, { type: 'toolResult' }>,
  run: AgentRun,
  result: unknown,
): Promise<void> {
  if (interaction.item.toolName === REQUEST_USER_INPUT_TOOL_NAME) {
    run.resume({
      type: 'toolResult',
      interactionId: interaction.interactionId,
      result: validateUserInputResolution(
        UserInputRequestSchema.parse(interaction.item.input),
        result,
      ),
    });
    return;
  }
  if (interaction.item.toolName !== PLAN_EXIT_TOOL_NAME) {
    throw new Error(`Unsupported deferred tool: ${interaction.item.toolName}`);
  }
  const decision = ApprovalDecisionSchema.parse(result);
  const snapshot = options.snapshot();
  const plan = snapshot.plan;
  if (plan === null) throw new Error('Plan disappeared before approval.');
  if (isAccepted(decision)) {
    const artifact = await readPlanArtifact(
      snapshot.thread.cwd,
      snapshot.thread.id,
    );
    if (artifact.contentHash !== plan.contentHash) {
      throw invalidParams('Plan content hash is stale.');
    }
  }
  const updatedPlan = {
    ...plan,
    status: isAccepted(decision)
      ? ('accepted' as const)
      : ('rejected' as const),
    updatedAt: new Date().toISOString(),
  };
  await options.append({ kind: 'plan.state', plan: updatedPlan });
  if (updatedPlan.status === 'accepted') {
    await options.append({
      kind: 'thread.metadata',
      settings: { ...snapshot.settings, mode: 'ask-before-changes' },
    });
  }
  run.resume({
    type: 'toolResult',
    interactionId: interaction.interactionId,
    result: planResult(decision),
    ...(updatedPlan.status === 'accepted'
      ? { mode: 'ask-before-changes' as const }
      : {}),
  });
}

function requirePending(
  snapshot: ThreadSnapshot,
  pending: ReadonlyMap<string, PendingInteraction>,
  requestId: string,
): PendingInteraction {
  if (
    !snapshot.pendingServerRequests.some((request) => request.id === requestId)
  ) {
    throw new Error(`Server Request ${requestId} is not pending.`);
  }
  const entry = pending.get(requestId);
  if (entry === undefined) {
    throw new Error(`Server Request ${requestId} has no active interaction.`);
  }
  return entry;
}

function appendResolution(
  options: ThreadInteractionsOptions,
  requestId: string,
  resolution: 'resolved' | 'rejected',
): Promise<ThreadRecord> {
  const request = options
    .snapshot()
    .pendingServerRequests.find((candidate) => candidate.id === requestId);
  if (request === undefined) {
    throw new Error(`Server Request ${requestId} is not pending.`);
  }
  return options.append({
    kind: 'serverRequest.resolved',
    requestId,
    turnId: request.turnId,
    itemId: request.itemId,
    resolution,
  });
}

function approvalMethod(
  toolName: string,
  request: Record<string, unknown>,
):
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval' {
  if (toolName === 'bash' || request.kind === 'shell') {
    return 'item/commandExecution/requestApproval';
  }
  if (
    ['write', 'edit', 'apply_patch'].includes(toolName) ||
    request.kind === 'edit'
  ) {
    return 'item/fileChange/requestApproval';
  }
  return 'item/permissions/requestApproval';
}

function approvalExternalDirs(
  item: Extract<AgentInteraction, { type: 'approval' }>['item'],
): ReadonlyArray<string> {
  const externalDirs = item.metadata?.externalDirs;
  if (externalDirs === undefined) return [];
  if (!Array.isArray(externalDirs) || !externalDirs.every(isNonEmptyString)) {
    throw new Error('Approval externalDirs metadata must be a string array.');
  }
  return externalDirs;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAccepted(decision: ApprovalDecision): boolean {
  return (
    decision.decision === 'accept' || decision.decision === 'acceptForSession'
  );
}

function planResult(decision: ApprovalDecision): string {
  return isAccepted(decision)
    ? 'Plan accepted. Continue by executing the approved plan.'
    : decision.decision === 'decline'
      ? 'Plan declined.'
      : 'Plan approval cancelled.';
}

/**
 * 把交互边界错误转换为 Agent rejection 使用的稳定数值错误。
 *
 * Args:
 * - `error`: 校验、持久化前置步骤或产品状态转换抛出的未知错误值。
 *
 * Returns:
 * - 返回保留 App Server 错误码的 rejection；普通 Error 使用 internal 错误码并保留原消息。
 */
function interactionError(error: unknown): {
  readonly code: number;
  readonly message: string;
} {
  if (error instanceof AppServerError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: APP_SERVER_ERROR_CODES.internal, message: error.message };
  }
  return {
    code: APP_SERVER_ERROR_CODES.internal,
    message: `Interaction resolution threw a non-Error value: ${String(error)}`,
  };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireString(value: unknown, label: string): string {
  const text = readString(value);
  if (text === undefined) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return text;
}

function readStringArray(value: unknown, label: string): ReadonlyArray<string> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string => typeof item === 'string')
  ) {
    throw new Error(`${label} must be a non-empty string array.`);
  }
  return value;
}
