/**
 * 本文件负责 tool feature 的“rules-store”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { readFile } from 'node:fs/promises';

import { errnoCode } from '../../../infra/filesystem.js';
import type { DeferredApprovalItem } from '../../agent/engine/index.js';
import {
  atomicWriteText,
  parseYamlConfig,
  projectPermissionsFile,
  stringifyYamlConfig,
  userPermissionsFile,
} from '../../config/index.js';

import type { ApprovalPolicyMetadata } from './policy.js';
import type {
  PermissionAction,
  PermissionRule,
  PermissionScope,
} from './types.js';
import { parsePermissionRules } from './types.js';

export type RuleScope = 'session' | 'project' | 'user';

/** 用户级权限规则文件：`~/.ello/permissions.yaml`。 */
/**
 * 权限规则持久化存储。
 *
 * 当用户在审批浮层选择 always allow / deny 时，按审批 metadata 中的
 * always patterns 写入规则；工具必须提供类型化 metadata，store 不从原始 input 猜。
 */
export class RulesStore {
  private readonly sessionRules: PermissionRule[] = [];
  private projectRules: PermissionRule[] | undefined;
  private userRules: PermissionRule[] | undefined;

  /**
   * 创建 `RulesStore`，由该实例独占 工具 `rules-store` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
   */
  constructor(private readonly cwd: string) {}

  /**
   * 动态规则按 user -> project -> session 拼接，session 规则最后匹配优先级最高。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  rules(): readonly PermissionRule[] {
    return [
      ...requireLoadedRules(this.userRules, 'user'),
      ...requireLoadedRules(this.projectRules, 'project'),
      ...this.sessionRules,
    ];
  }

  /**
   * 预加载磁盘规则，之后 rules() 同步返回当前进程视图。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 工具 `rules-store` 模块 的异步副作用完整提交后兑现，不返回业务值。
   *
   * Throws:
   * - 当 工具 `rules-store` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  async load(): Promise<void> {
    this.projectRules = await readRulesFile(projectPermissionsFile(this.cwd));
    this.userRules = await readRulesFile(userPermissionsFile());
  }

  /**
   * 按 工具 `rules-store` 模块 的一致性约束执行 `addAllowRule` 状态变更。
   *
   * Args:
   * - `item`: 要由 `addAllowRule` 读取或写入的单个领域值；所有权仍归调用方。
   * - `scope`: `addAllowRule` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 工具 `rules-store` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async addAllowRule(
    item: DeferredApprovalItem,
    scope: RuleScope,
  ): Promise<void> {
    await this.addRules(item, 'allow', scope);
  }

  /**
   * 按 工具 `rules-store` 模块 的一致性约束执行 `addDenyRule` 状态变更。
   *
   * Args:
   * - `item`: 要由 `addDenyRule` 读取或写入的单个领域值；所有权仍归调用方。
   * - `scope`: `addDenyRule` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 工具 `rules-store` 模块 的异步副作用完整提交后兑现，不返回业务值。
   */
  async addDenyRule(
    item: DeferredApprovalItem,
    scope: RuleScope,
  ): Promise<void> {
    await this.addRules(item, 'deny', scope);
  }

  private async addRules(
    item: DeferredApprovalItem,
    action: PermissionAction,
    scope: RuleScope,
  ): Promise<void> {
    const meta = extractPolicyMetadata(item);
    // always patterns 是工具声明的持久化匹配目标，不能从 input 反推。
    const rules: PermissionRule[] = meta.always.map((pattern) => ({
      permission: meta.permission,
      pattern,
      action,
      scope: scopeToPermissionScope(scope),
      source: `approval:${meta.proxiedTool ?? item.toolName}`,
    }));
    if (action === 'allow' && meta.externalDirs !== undefined) {
      rules.push(
        ...meta.externalDirs.map((externalDir) => ({
          permission: 'external_directory',
          pattern: externalDir,
          action: 'allow' as const,
          scope: scopeToPermissionScope(scope),
          source: `approval:${meta.proxiedTool ?? item.toolName}`,
        })),
      );
    }
    await this.persistRules(rules, scope);
  }

  private async persistRules(
    rules: readonly PermissionRule[],
    scope: RuleScope,
  ): Promise<void> {
    switch (scope) {
      case 'session':
        this.sessionRules.push(...rules);
        return;
      case 'project':
        await this.appendToFile(
          projectPermissionsFile(this.cwd),
          rules,
          () => requireLoadedRules(this.projectRules, 'project'),
          (next) => {
            this.projectRules = next;
          },
        );
        return;
      case 'user':
        await this.appendToFile(
          userPermissionsFile(),
          rules,
          () => requireLoadedRules(this.userRules, 'user'),
          (next) => {
            this.userRules = next;
          },
        );
        return;
    }
  }

  private async appendToFile(
    filePath: string,
    additions: readonly PermissionRule[],
    getCurrent: () => readonly PermissionRule[],
    setCurrent: (rules: PermissionRule[]) => void,
  ): Promise<void> {
    const next = [...getCurrent(), ...additions];
    await atomicWriteText(
      filePath,
      stringifyYamlConfig({ rules: serializeRules(next) }),
    );
    // 磁盘提交成功后再发布进程内快照，避免写盘失败留下仅当前进程可见的幽灵规则。
    setCurrent(next);
  }
}

/**
 * 读取已经完成磁盘加载的规则快照，防止未初始化 store 被当作空规则集使用。
 *
 * Args:
 * - `rules`: 对应 scope 的进程内快照；`undefined` 表示 `load()` 尚未成功完成。
 * - `scope`: 用于错误定位的规则作用域名称。
 *
 * Returns:
 * - 返回已加载规则数组的当前快照引用，调用方只读使用。
 *
 * Throws:
 * - `load()` 尚未完成时直接抛错。
 */
function requireLoadedRules(
  rules: PermissionRule[] | undefined,
  scope: 'project' | 'user',
): PermissionRule[] {
  if (rules === undefined) {
    throw new Error(
      `RulesStore.load() must complete before reading ${scope} rules.`,
    );
  }
  return rules;
}

function scopeToPermissionScope(scope: RuleScope): PermissionScope {
  return scope;
}

function extractPolicyMetadata(
  item: DeferredApprovalItem,
): ApprovalRuleMetadata {
  const metadata = item.metadata;
  if (metadata === undefined) {
    throw new Error(
      `Approval item for ${item.toolName} has no policy metadata.`,
    );
  }
  const parsed = ApprovalPolicyMetadataSchema.parse(metadata);
  if (item.toolName !== 'call_tool') {
    return parsed;
  }
  return { ...parsed, proxiedTool: readString(metadata, 'proxiedTool') };
}

const ApprovalPolicyMetadataSchema = {
  parse(value: unknown): ApprovalRuleMetadata {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Approval policy metadata must be an object.');
    }
    return {
      permission: readString(value, 'permission'),
      patterns: readStringArray(value, 'patterns'),
      always: readStringArray(value, 'always'),
      ...(Reflect.get(value, 'externalDirs') !== undefined
        ? { externalDirs: readStringArray(value, 'externalDirs') }
        : {}),
    };
  },
};

type ApprovalRuleMetadata = Pick<
  ApprovalPolicyMetadata,
  'permission' | 'patterns' | 'always' | 'externalDirs' | 'proxiedTool'
>;

function readString(record: object, key: string): string {
  const value = Reflect.get(record, key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Approval policy metadata field '${key}' must be a string.`,
    );
  }
  return value;
}

function readStringArray(record: object, key: string): readonly string[] {
  const value = Reflect.get(record, key);
  if (!Array.isArray(value)) {
    throw new Error(
      `Approval policy metadata field '${key}' must be a string array.`,
    );
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(
        `Approval policy metadata field '${key}' must be a string array.`,
      );
    }
    return item;
  });
}

function serializeRules(
  rules: readonly PermissionRule[],
): Array<Record<string, unknown>> {
  return rules.map((rule) => ({
    permission: rule.permission,
    pattern: rule.pattern,
    action: rule.action,
    scope: rule.scope,
    ...(rule.source !== undefined ? { source: rule.source } : {}),
    ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
  }));
}

async function readRulesFile(filePath: string): Promise<PermissionRule[]> {
  try {
    const text = await readFile(filePath, 'utf8');
    const parsed = parseYamlConfig(text);
    return parsePermissionRules(parsed.rules);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
