/**
 * 本文件负责 agent feature 的“recovery”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { AgentMessage } from '../engine/index.js';

import {
  UserInputRequestSchema,
  type PendingUserInput,
  type UserInputResolution,
} from './schema.js';
import { REQUEST_USER_INPUT_TOOL_NAME } from './tool.js';

/**
 * 从 raw active transcript 恢复唯一未配对的问询调用。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 * - `sessionId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
 *
 * Returns:
 * - 返回匹配值；领域上允许不存在时显式返回 `null` 或 `undefined`，不会合成默认对象。
 */
export function recoverPendingUserInput(
  messages: readonly AgentMessage[],
  sessionId: string,
): PendingUserInput | null {
  const calls = new Map<string, unknown>();
  const results = new Set<string>();
  for (const message of messages) {
    const content = Reflect.get(message, 'content');
    if (!Array.isArray(content)) continue;
    const parts: ReadonlyArray<unknown> = content;
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const id = readString(part.toolCallId ?? part.id);
      if (id === undefined) continue;
      if (
        message.role === 'assistant' &&
        part.type === 'tool-call' &&
        readString(part.toolName ?? part.name) === REQUEST_USER_INPUT_TOOL_NAME
      ) {
        if (calls.has(id)) {
          throw new Error(
            `Session ${sessionId} contains duplicate request_user_input call ${id}.`,
          );
        }
        calls.set(id, part.input ?? part.args);
      } else if (message.role === 'tool' && part.type === 'tool-result') {
        results.add(id);
      }
    }
  }
  const pending = [...calls].filter(([id]) => !results.has(id));
  if (pending.length > 1) {
    throw new Error(
      `Session ${sessionId} contains multiple pending user input calls: ${pending.map(([id]) => id).join(', ')}.`,
    );
  }
  const item = pending[0];
  if (item === undefined) return null;
  try {
    return {
      toolCallId: item[0],
      request: UserInputRequestSchema.parse(item[1]),
    };
  } catch (error) {
    throw new Error(
      `Session ${sessionId} contains invalid pending user input ${item[0]}.`,
      { cause: error },
    );
  }
}

/**
 * 执行 产品 Agent `recovery` 模块 定义的 `summarizeUserInputResolution` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `resolution`: `summarizeUserInputResolution` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `summarizeUserInputResolution` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function summarizeUserInputResolution(
  resolution: UserInputResolution,
): string {
  if (resolution.status === 'denied') return 'Denied';
  if (resolution.status === 'chat') return 'Chat about this';
  return resolution.answers
    .map(
      (answer) =>
        `${answer.questionId}: ${answer.selected
          .map((selection) =>
            selection === 'Other' ? (answer.otherText ?? selection) : selection,
          )
          .join(', ')}`,
    )
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
