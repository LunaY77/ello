import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeferredApprovalItem } from '@ello/agent';

import { parsePermissionRules, type PermissionRule } from '../permissions.js';
import { projectPermissionsFile } from '../session/paths.js';
import { parseYamlConfig, stringifyYamlConfig } from '../utils/yaml.js';

/** “总是允许/拒绝”的作用域。 */
export type RuleScope = 'session' | 'project';

/**
 * 权限规则持久化存储。
 *
 * 当用户在审批浮层选择 “always allow / deny” 时，{@link CodingSession.approve}
 * 调用本 store 落规则：
 * - `session` 作用域：仅存进程内存，随会话消失；
 * - `project` 作用域：写 `<repo>/.ello/permissions.yaml`，跨会话生效。
 *
 * `rules()` 合并内存与磁盘规则，交给 {@link makeApprovalPolicy} 实时匹配。
 * 规则结构沿用 `permissions.ts` 的 {@link PermissionRule}。
 */
export class RulesStore {
  /** 进程内 session 规则。 */
  private readonly sessionRules: PermissionRule[] = [];

  /** 从 permissions.yaml 读到的 project 规则（首次访问时懒加载）。 */
  private projectRules: PermissionRule[] | undefined;

  constructor(private readonly cwd: string) {}

  /** 返回当前生效的全部规则（session + project）。 */
  rules(): readonly PermissionRule[] {
    return [...this.sessionRules, ...(this.projectRules ?? [])];
  }

  /** 预加载磁盘上的 project 规则，让后续 `rules()` 同步可用。 */
  async load(): Promise<void> {
    this.projectRules = await this.readProjectRules();
  }

  /** 把一个审批待决项转成 allow 规则并按作用域持久化。 */
  async addAllowRule(
    item: DeferredApprovalItem,
    scope: RuleScope,
  ): Promise<void> {
    await this.addRule(toRule(item, 'allow', scope));
  }

  /** 把一个审批待决项转成 deny 规则并按作用域持久化。 */
  async addDenyRule(
    item: DeferredApprovalItem,
    scope: RuleScope,
  ): Promise<void> {
    await this.addRule(toRule(item, 'deny', scope));
  }

  private async addRule(rule: PermissionRule): Promise<void> {
    if (rule.scope === 'session') {
      this.sessionRules.push(rule);
      return;
    }
    const existing = await this.readProjectRules();
    const next = [...existing, rule];
    this.projectRules = next;
    const filePath = projectPermissionsFile(this.cwd);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, stringifyYamlConfig({ rules: next }), 'utf8');
  }

  private async readProjectRules(): Promise<PermissionRule[]> {
    if (this.projectRules !== undefined) {
      return this.projectRules;
    }
    try {
      const text = await readFile(projectPermissionsFile(this.cwd), 'utf8');
      const parsed = parseYamlConfig(text);
      this.projectRules = parsePermissionRules(parsed.rules);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.projectRules = [];
    }
    return this.projectRules;
  }
}

/** 把审批待决项映射成可持久化规则：优先使用 typed metadata 精确匹配。 */
function toRule(
  item: DeferredApprovalItem,
  action: 'allow' | 'deny',
  scope: RuleScope,
): PermissionRule {
  const input = (item.input ?? undefined) as
    | Record<string, unknown>
    | undefined;
  const metadata = (item.metadata ?? undefined) as
    | Record<string, unknown>
    | undefined;
  return {
    action,
    tool: item.toolName,
    scope,
    ...(typeof metadata?.path === 'string'
      ? { pathGlob: metadata.path }
      : typeof input?.path === 'string'
        ? { pathGlob: input.path }
        : {}),
    ...(typeof metadata?.command === 'string'
      ? { commandPattern: escapeRegExp(metadata.command) }
      : typeof input?.command === 'string'
        ? { commandPattern: escapeRegExp(input.command) }
        : {}),
    ...(typeof metadata?.domain === 'string'
      ? { domain: metadata.domain }
      : {}),
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
