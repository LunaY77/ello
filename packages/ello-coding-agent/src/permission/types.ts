import { z } from 'zod';

import type { FileChange } from '../tools/file-change.js';

export const PermissionActionSchema = z.enum(['allow', 'ask', 'deny']);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

/** 规则作用域决定规则来源、落点和合并优先级。 */
export const PermissionScopeSchema = z.enum([
  'default',
  'session',
  'project',
  'user',
]);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

/**
 * 权限规则的唯一持久化形态。
 *
 * `permission` 是能力类别，`pattern` 是该类别内的匹配目标；匹配顺序由
 * `evaluatePermission()` 决定，规则本身不携带工具入参结构。
 */
export const PermissionRuleSchema = z.object({
  permission: z.string().min(1),
  pattern: z.string().min(1),
  action: PermissionActionSchema,
  scope: PermissionScopeSchema.default('session'),
  source: z.string().optional(),
  reason: z.string().optional(),
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

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
 * `patterns` 用于本次判定；`always` 是用户选择 always allow 时写入规则的目标；
 * `paths` 列出本次会触碰的文件系统路径，用来派生 external_directory 审批。
 */
export interface PermissionDescriptor {
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly always: readonly string[];
  readonly metadata: PermissionMetadata;
  readonly paths?: readonly string[];
}

export function parsePermissionRules(value: unknown): PermissionRule[] {
  return z.array(PermissionRuleSchema).parse(value);
}
