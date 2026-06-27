import path from 'node:path';

import type { AgentContext, RuntimeToolset, ToolArgs, ToolsetTool } from '@ello/agent';
import { z } from 'zod';


import type { ApprovalMode } from './config.js';

export const PermissionActionSchema = z.enum(['allow', 'deny', 'ask']);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

export const PermissionRuleSchema = z.object({
  tool: z.string().default('*'),
  action: PermissionActionSchema,
  path: z.string().optional(),
  command: z.string().optional(),
  reason: z.string().optional(),
});
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export interface PermissionDecision {
  /** 由显式规则、审批模式或默认风险策略选出的最终动作。 */
  action: PermissionAction;
  /** 持久化到会话日志并展示在审批 UI 中的可读原因。 */
  reason: string;
  /** 当决策来自配置时，记录本次调用命中的显式规则。 */
  rule?: PermissionRule;
}

export interface PermissionContext {
  /** 未被显式规则覆盖时使用的全局审批姿态。 */
  approvalMode: ApprovalMode;
  /** 用户或项目配置的 allow、deny、ask 规则；规则会优先求值。 */
  rules: PermissionRule[];
  /** 用于解析相对规则路径和工具路径的工作目录。 */
  cwd: string;
  /** 无需额外边界审批即可使用的文件系统根路径。 */
  allowedPaths: string[];
}

/**
 * 包装 toolset，让权限检查可以拦截工具执行并触发审批。
 *
 * 该包装器只会在调用时阻断显式 `deny` 决策。`ask` 决策通过
 * `requiresApproval` 暴露给核心 runtime，使其可以暂停、持久化延迟审批状态，
 * 并在同一个工具调用上恢复执行。
 */
export class PermissionToolset implements RuntimeToolset {
  constructor(
    private readonly inner: RuntimeToolset,
    private readonly context: PermissionContext,
  ) {}

  get hasApprovalTools(): boolean {
    return true;
  }

  async getTools(ctx: { deps: AgentContext }): Promise<Record<string, ToolsetTool>> {
    const tools = await this.inner.getTools(ctx);
    const result: Record<string, ToolsetTool> = {};
    for (const [name, toolDef] of Object.entries(tools)) {
      result[name] = {
        ...toolDef,
        requiresApproval:
          toolDef.requiresApproval ||
          evaluateToolPermission(this.context, name, {}).action === 'ask',
        requiresApprovalFor: (args) =>
          Boolean(toolDef.requiresApprovalFor?.(args)) ||
          evaluateToolPermission(this.context, name, args).action === 'ask',
      };
    }
    return result;
  }

  async callTool(
    name: string,
    toolArgs: ToolArgs,
    ctx: { deps: AgentContext },
    tool?: ToolsetTool,
  ): Promise<unknown> {
    const decision = evaluateToolPermission(this.context, name, toolArgs);
    if (decision.action === 'deny') {
      return `denied: ${decision.reason}`;
    }
    return this.inner.callTool(name, toolArgs, ctx, tool);
  }
}

/**
 * 为一次工具调用评估当前权限策略。
 *
 * 决策顺序有意贴近 Codex/Claude Code 风格：显式规则最优先，
 * `approvalMode` 可全局强制 allow/ask，on-request 模式会对 shell、网络、
 * 文件变更或超出允许根路径的文件系统访问请求审批。
 */
export function evaluateToolPermission(
  context: PermissionContext,
  toolName: string,
  input: unknown,
): PermissionDecision {
  for (const rule of context.rules) {
    if (!ruleMatches(rule, context.cwd, toolName, input)) {
      continue;
    }
    return {
      action: rule.action,
      reason: rule.reason ?? `Matched permission rule for ${rule.tool}.`,
      rule,
    };
  }

  if (context.approvalMode === 'never') {
    return { action: 'allow', reason: 'approvalMode=never' };
  }
  if (context.approvalMode === 'always') {
    return { action: 'ask', reason: 'approvalMode=always' };
  }

  const pathDecision = evaluateAllowedPaths(context, input);
  if (pathDecision !== null) {
    return pathDecision;
  }

  if (toolName === 'shell_exec') {
    return { action: 'ask', reason: 'Shell commands require approval.' };
  }
  if (toolName === 'delete_file') {
    return { action: 'ask', reason: 'Deleting files requires approval.' };
  }
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'move_copy') {
    return { action: 'ask', reason: 'File mutations require approval.' };
  }
  if (toolName.startsWith('web_')) {
    return { action: 'ask', reason: 'Network access requires approval.' };
  }
  return { action: 'allow', reason: 'Read-only local tool.' };
}

/**
 * 从配置或环境输入中解析序列化后的权限规则。
 */
export function parsePermissionRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => PermissionRuleSchema.parse(item));
}

/**
 * 将权限规则格式化为紧凑的 CLI 表格。
 */
export function formatPermissionRules(rules: PermissionRule[]): string {
  if (rules.length === 0) {
    return 'No explicit permission rules configured.';
  }
  return rules
    .map((rule) => {
      const filters = [
        rule.path ? `path=${rule.path}` : null,
        rule.command ? `command=${rule.command}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      return `${rule.action}\t${rule.tool}${filters ? `\t${filters}` : ''}`;
    })
    .join('\n');
}

function ruleMatches(
  rule: PermissionRule,
  cwd: string,
  toolName: string,
  input: unknown,
): boolean {
  if (rule.tool !== '*' && rule.tool !== toolName) {
    return false;
  }
  if (rule.path !== undefined) {
    const targets = extractPaths(input);
    if (targets.length === 0) {
      return false;
    }
    const resolvedRulePath = path.resolve(cwd, rule.path);
    if (!targets.some((target) => isPathInside(path.resolve(cwd, target), resolvedRulePath))) {
      return false;
    }
  }
  if (rule.command !== undefined) {
    const command = extractCommand(input);
    if (command === null || !command.includes(rule.command)) {
      return false;
    }
  }
  return true;
}

function evaluateAllowedPaths(
  context: PermissionContext,
  input: unknown,
): PermissionDecision | null {
  const targets = extractPaths(input);
  if (targets.length === 0 || context.allowedPaths.length === 0) {
    return null;
  }

  const outsidePath = targets
    .map((target) => ({
      original: target,
      resolved: path.resolve(context.cwd, target),
    }))
    .find((target) =>
      !context.allowedPaths.some((allowedPath) =>
        isPathInside(target.resolved, path.resolve(context.cwd, allowedPath)),
      ),
    );

  if (outsidePath === undefined) {
    return null;
  }

  return {
    action: 'ask',
    reason: `Path is outside allowedPaths: ${outsidePath.original}`,
  };
}

function extractPaths(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) {
    return [];
  }
  const record = input as Record<string, unknown>;
  return [
    'path',
    'filePath',
    'targetPath',
    'source',
    'destination',
    'from',
    'to',
  ]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function extractCommand(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const record = input as Record<string, unknown>;
  return typeof record.command === 'string' ? record.command : null;
}

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
