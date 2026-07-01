import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeferredApprovalItem } from '@ello/agent';

import { elloHomeDir } from '../config/paths.js';
import { projectPermissionsFile } from '../session/paths.js';
import { parseYamlConfig, stringifyYamlConfig } from '../utils/yaml.js';

import type { ApprovalPolicyMetadata } from './policy.js';
import type {
  PermissionAction,
  PermissionRule,
  PermissionScope,
} from './types.js';
import { parsePermissionRules } from './types.js';

export type RuleScope = 'session' | 'project' | 'user';

/** 用户级权限规则文件：`~/.ello/permissions.yaml`。 */
function userPermissionsFile(): string {
  return path.join(elloHomeDir(), 'permissions.yaml');
}

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

  constructor(private readonly cwd: string) {}

  /** 动态规则按 user -> project -> session 拼接，session 规则最后匹配优先级最高。 */
  rules(): readonly PermissionRule[] {
    return [
      ...(this.userRules ?? []),
      ...(this.projectRules ?? []),
      ...this.sessionRules,
    ];
  }

  /** 预加载磁盘规则，之后 rules() 同步返回当前进程视图。 */
  async load(): Promise<void> {
    this.projectRules = await readRulesFile(projectPermissionsFile(this.cwd));
    this.userRules = await readRulesFile(userPermissionsFile());
  }

  async addAllowRule(
    item: DeferredApprovalItem,
    scope: RuleScope,
  ): Promise<void> {
    await this.addRules(item, 'allow', scope);
  }

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
    for (const pattern of meta.always) {
      await this.persistRule(
        {
          permission: meta.permission,
          pattern,
          action,
          scope: scopeToPermissionScope(scope),
          source: `approval:${item.toolName}`,
        },
        scope,
      );
    }
    if (action === 'allow' && meta.externalDirs !== undefined) {
      // 外部目录授权需要作为独立 permission 落规则，运行时边界据此放行。
      for (const externalDir of meta.externalDirs) {
        await this.persistRule(
          {
            permission: 'external_directory',
            pattern: externalDir,
            action: 'allow',
            scope: scopeToPermissionScope(scope),
            source: `approval:${item.toolName}`,
          },
          scope,
        );
      }
    }
  }

  private async persistRule(
    rule: PermissionRule,
    scope: RuleScope,
  ): Promise<void> {
    switch (scope) {
      case 'session':
        this.sessionRules.push(rule);
        return;
      case 'project':
        await this.appendToFile(
          projectPermissionsFile(this.cwd),
          rule,
          () => this.projectRules ?? [],
          (rules) => {
            this.projectRules = rules;
          },
        );
        return;
      case 'user':
        await this.appendToFile(
          userPermissionsFile(),
          rule,
          () => this.userRules ?? [],
          (rules) => {
            this.userRules = rules;
          },
        );
        return;
    }
  }

  private async appendToFile(
    filePath: string,
    rule: PermissionRule,
    getCurrent: () => readonly PermissionRule[],
    setCurrent: (rules: PermissionRule[]) => void,
  ): Promise<void> {
    const next = [...getCurrent(), rule];
    setCurrent(next);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      stringifyYamlConfig({ rules: serializeRules(next) }),
      'utf8',
    );
  }
}

function scopeToPermissionScope(scope: RuleScope): PermissionScope {
  return scope;
}

function extractPolicyMetadata(
  item: DeferredApprovalItem,
): ApprovalPolicyMetadata {
  const metadata = item.metadata;
  if (metadata === undefined) {
    throw new Error(
      `Approval item for ${item.toolName} has no policy metadata.`,
    );
  }
  const parsed = ApprovalPolicyMetadataSchema.parse(metadata);
  return parsed;
}

const ApprovalPolicyMetadataSchema = {
  parse(value: unknown): ApprovalPolicyMetadata {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Approval policy metadata must be an object.');
    }
    const record = value as Record<string, unknown>;
    return {
      permission: readString(record, 'permission'),
      patterns: readStringArray(record, 'patterns'),
      always: readStringArray(record, 'always'),
      ...(record.externalDirs !== undefined
        ? { externalDirs: readStringArray(record, 'externalDirs') }
        : {}),
      request: record.request as ApprovalPolicyMetadata['request'],
    };
  },
};

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Approval policy metadata field '${key}' must be a string.`,
    );
  }
  return value;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(
      `Approval policy metadata field '${key}' must be a string array.`,
    );
  }
  return value as readonly string[];
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
