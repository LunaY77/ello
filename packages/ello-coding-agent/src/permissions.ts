import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

/** 产品层权限动作。 */
export type PermissionAction = 'allow' | 'ask' | 'deny';

/** coding-agent 权限模式。 */
export type PermissionMode = 'default' | 'plan' | 'accept-edits' | 'dont-ask' | 'bypass';

export const PermissionModeSchema = z.enum(['default', 'plan', 'accept-edits', 'dont-ask', 'bypass']);

/** 可持久化权限规则。 */
export const PermissionRuleSchema = z.object({
  action: z.enum(['allow', 'ask', 'deny']),
  tool: z.string().optional(),
  pathGlob: z.string().optional(),
  commandPattern: z.string().optional(),
  domain: z.string().optional(),
  scope: z.enum(['session', 'project', 'user', 'default']).default('session'),
  reason: z.string().optional(),
});

export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

/** 权限判定上下文。 */
export interface PermissionContext {
  readonly toolName: string;
  readonly input?: unknown;
  readonly cwd: string;
  readonly allowedPaths: readonly string[];
  readonly mode: PermissionMode;
  readonly rules?: readonly PermissionRule[];
  readonly repeatedDenials?: ReadonlyMap<string, number>;
}

/** 权限判定结果。 */
export interface PermissionDecision {
  readonly action: PermissionAction;
  readonly reason: string;
  readonly matchedRule?: PermissionRule;
}

/**
 * 权限策略引擎。
 *
 * 规则来源由调用方合并后传入，本函数只做确定性判定：显式规则优先，
 * 然后按 permission mode 和工具风险分类给出 allow/ask/deny。
 */
export function evaluateToolPermission(ctx: PermissionContext): PermissionDecision {
  const explicit = ctx.rules?.find((rule) => matchRule(rule, ctx));
  if (explicit !== undefined) {
    return { action: explicit.action, reason: explicit.reason ?? `matched ${explicit.scope} rule`, matchedRule: explicit };
  }
  if (ctx.repeatedDenials?.get(denialKey(ctx)) !== undefined && (ctx.repeatedDenials.get(denialKey(ctx)) ?? 0) >= 2) {
    return { action: 'deny', reason: 'same operation was denied repeatedly' };
  }
  if (ctx.mode === 'bypass' || ctx.mode === 'dont-ask') {
    return { action: 'allow', reason: `${ctx.mode} mode` };
  }
  if (ctx.mode === 'plan') {
    return isReadOnlyTool(ctx.toolName) ? { action: 'allow', reason: 'read-only tool in plan mode' } : { action: 'deny', reason: 'plan mode blocks write, shell and network tools' };
  }
  if (ctx.mode === 'accept-edits') {
    if ((ctx.toolName === 'write' || ctx.toolName === 'edit') && targetInsideAllowedPath(ctx)) {
      return { action: 'allow', reason: 'accept-edits mode allows workspace edits' };
    }
    if (isReadOnlyTool(ctx.toolName)) {
      return { action: 'allow', reason: 'read-only tool' };
    }
    return { action: 'ask', reason: 'accept-edits mode still asks for shell and network tools' };
  }
  if (isReadOnlyTool(ctx.toolName)) {
    return { action: 'allow', reason: 'read-only tool' };
  }
  return { action: 'ask', reason: 'default mode asks for mutating or external tools' };
}

/** 将产品权限动作映射到 @ello/agent 工具 approval 返回值。 */
export function applyPermissionPolicy(ctx: PermissionContext): 'auto' | 'required' | 'denied' {
  const decision = evaluateToolPermission(ctx);
  if (decision.action === 'allow') {
    return 'auto';
  }
  if (decision.action === 'deny') {
    return 'denied';
  }
  return 'required';
}

/** 解析 JSON 或对象数组形式的权限规则。 */
export function parsePermissionRules(value: unknown): PermissionRule[] {
  if (typeof value === 'string' && value.trim()) {
    return z.array(PermissionRuleSchema).parse(JSON.parse(value));
  }
  if (Array.isArray(value)) {
    return z.array(PermissionRuleSchema).parse(value);
  }
  return [];
}

/** 输出人类可读规则表。 */
export function formatPermissionRules(rules: readonly PermissionRule[]): string {
  if (rules.length === 0) {
    return 'rules\t<none>';
  }
  return rules
    .map((rule) => {
      const parts = [`${rule.action}`];
      if (rule.tool !== undefined) parts.push(`tool=${rule.tool}`);
      if (rule.pathGlob !== undefined) parts.push(`path=${rule.pathGlob}`);
      if (rule.commandPattern !== undefined) parts.push(`command=${rule.commandPattern}`);
      if (rule.domain !== undefined) parts.push(`domain=${rule.domain}`);
      parts.push(`scope=${rule.scope}`);
      return parts.join('\t');
    })
    .join('\n');
}

/** 记录 repeated denial 的稳定 key。 */
export function denialKey(ctx: Pick<PermissionContext, 'toolName' | 'input'>): string {
  return `${ctx.toolName}:${JSON.stringify(ctx.input ?? null)}`;
}

/** 权限规则持久化存储。 */
export class PermissionStore {
  private readonly sessionRules: PermissionRule[] = [];

  constructor(private readonly cwd: string) {}

  /** 当前 session 内动态规则。 */
  rules(): readonly PermissionRule[] {
    return [...this.sessionRules];
  }

  /** 添加规则并按 scope 持久化。 */
  async addRule(rule: PermissionRule): Promise<void> {
    if (rule.scope === 'session') {
      this.sessionRules.push(rule);
      return;
    }
    const filePath =
      rule.scope === 'user'
        ? path.join(homedir(), '.ello', 'config.json')
        : rule.scope === 'project'
          ? path.join(this.cwd, '.ello', 'config.json')
          : path.join(this.cwd, '.ello', 'local.json');
    const current = await readConfig(filePath);
    const currentRules = parsePermissionRules(current.permissionRules);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify({ ...current, permissionRules: [...currentRules, rule] }, null, 2)}\n`,
      'utf8',
    );
  }
}

function matchRule(rule: PermissionRule, ctx: PermissionContext): boolean {
  if (rule.tool !== undefined && rule.tool !== ctx.toolName) {
    return false;
  }
  if (rule.commandPattern !== undefined) {
    const command = readInputString(ctx.input, 'command');
    if (command === undefined || !new RegExp(rule.commandPattern).test(command)) {
      return false;
    }
  }
  if (rule.pathGlob !== undefined) {
    const targetPath = readInputString(ctx.input, 'path');
    if (targetPath === undefined || !globLikeMatch(rule.pathGlob, targetPath)) {
      return false;
    }
  }
  if (rule.domain !== undefined) {
    const url = readInputString(ctx.input, 'url') ?? readInputString(ctx.input, 'query');
    if (url === undefined || !url.includes(rule.domain)) {
      return false;
    }
  }
  return true;
}

function isReadOnlyTool(toolName: string): boolean {
  return toolName === 'read' || toolName === 'ls' || toolName === 'grep' || toolName === 'glob' || toolName === 'todo' || toolName === 'tool_search';
}

function targetInsideAllowedPath(ctx: PermissionContext): boolean {
  const target = readInputString(ctx.input, 'path');
  if (target === undefined) {
    return false;
  }
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(ctx.cwd, target);
  return ctx.allowedPaths.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function readInputString(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function globLikeMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

async function readConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read permission config ${filePath}`, { cause: error });
  }
}
