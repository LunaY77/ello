/**
 * 本文件负责 Protocol 的“item-kind”模块职责。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 */
import type { ThreadItem } from './resources.js';

export type ToolThreadItem = Extract<
  ThreadItem,
  { readonly type: 'commandExecution' | 'fileChange' | 'toolCall' }
>;

export type ThreadItemKind = 'message' | 'tool' | 'subagent' | 'system';

/**
 * 工具类 item 由协议层统一分类，客户端与服务端不得复制字面量判断。
 *
 * Args:
 * - `item`: 要由 `isToolItem` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `isToolItem` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function isToolItem(item: ThreadItem): item is ToolThreadItem {
  switch (item.type) {
    case 'commandExecution':
    case 'fileChange':
    case 'toolCall':
      return true;
    case 'userMessage':
    case 'agentMessage':
    case 'reasoning':
    case 'plan':
    case 'subagent':
    case 'contextCompaction':
    case 'notice':
    case 'error':
      return false;
    default:
      item satisfies never;
      throw new Error(`Unhandled thread item: ${String(item)}`);
  }
}

/**
 * 执行 JSON-RPC 协议的 `item-kind` 模块 定义的 `itemKind` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `item`: 要由 `itemKind` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `itemKind` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function itemKind(item: ThreadItem): ThreadItemKind {
  if (isToolItem(item)) return 'tool';
  switch (item.type) {
    case 'userMessage':
    case 'agentMessage':
    case 'reasoning':
    case 'plan':
      return 'message';
    case 'subagent':
      return 'subagent';
    case 'contextCompaction':
    case 'notice':
    case 'error':
      return 'system';
    default:
      item satisfies never;
      throw new Error(`Unhandled thread item: ${String(item)}`);
  }
}
