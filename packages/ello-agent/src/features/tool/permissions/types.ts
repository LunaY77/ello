/**
 * 本文件负责 tool feature 的领域类型与闭合联合。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import {
  PermissionRuleSchema,
  type PermissionAction,
  type PermissionRule,
  type PermissionScope,
} from '../../config/index.js';
import type { FileChange } from '../internal/file-change.js';

export {
  PermissionRuleSchema,
  type PermissionAction,
  type PermissionRule,
  type PermissionScope,
};

/** TUI 审批展示只消费这些类型化字段，不读取工具原始 input。 */
export type PermissionMetadata =
  | { readonly kind: 'read'; readonly path: string }
  | {
      readonly kind: 'search';
      readonly pattern: string;
      readonly path?: string;
    }
  | {
      readonly kind: 'edit';
      readonly path: string;
      readonly fileChanges: readonly FileChange[];
    }
  | {
      readonly kind: 'shell';
      readonly command: string;
      readonly cwd: string;
      readonly externalPaths?: readonly string[];
      readonly risk?: 'normal' | 'dangerous';
    }
  | { readonly kind: 'network'; readonly url: string; readonly domain: string }
  | {
      readonly kind: 'task';
      readonly agentName: string;
      readonly description: string;
      readonly background: boolean;
    }
  | { readonly kind: 'external_directory'; readonly paths: readonly string[] }
  | { readonly kind: 'generic'; readonly inputPreview: string };

export interface PermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly always: readonly string[];
  readonly metadata: PermissionMetadata;
  readonly createdAt: string;
}

/**
 * 工具发起审批时必须提供的描述符。
 *
 * `patterns` 用于当前调用判定；`always` 是用户选择 always allow 时写入规则的目标；
 * `paths` 列出当前调用会触碰的文件系统路径，用来派生 external_directory 审批。
 */
export interface PermissionDescriptor {
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly always: readonly string[];
  readonly metadata: PermissionMetadata;
  readonly paths?: readonly string[];
}

/**
 * 校验 工具 `types` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `value`: 要由 `parsePermissionRules` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 *
 * Throws:
 * - 当 工具 `types` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parsePermissionRules(value: unknown): PermissionRule[] {
  return PermissionRuleSchema.array().parse(value);
}
