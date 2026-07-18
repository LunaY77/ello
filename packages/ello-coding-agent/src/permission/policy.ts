import type { AgentApprovalDecision, AgentToolContext } from '@ello/agent';

import type { CodingAgentConfig } from '../config/index.js';
import type { SessionModeState } from '../runtime/session-mode.js';

import {
  defaultRulesetForMode,
  evaluatePermission,
  isExternalPath,
  isPathInside,
  resolveAbsolute,
} from './engine.js';
import type {
  PermissionDescriptor,
  PermissionMetadata,
  PermissionRule,
} from './types.js';

export type DecideApproval = (
  descriptor: PermissionDescriptor,
  ctx: AgentToolContext,
) => AgentApprovalDecision;

/**
 * 把工具声明的 PermissionDescriptor 判定成 @ello/agent 的审批动作。
 *
 * 判定顺序是：先看工具自身 permission/pattern，再看 paths 派生出的
 * external_directory；任一 deny 直接拒绝，存在 ask 则进入人工审批。
 */
export function makeApprovalPolicy(
  config: CodingAgentConfig,
  dynamicRules: () => readonly PermissionRule[],
  mode: () => SessionModeState,
  readRoots: () => readonly string[] = () => [],
): DecideApproval {
  return (descriptor: PermissionDescriptor): AgentApprovalDecision => {
    assertDescriptor(descriptor);
    const currentMode = mode().mode;
    // Bypass 是显式开启的会话级安全边界，不能再被配置或历史规则降级成审批。
    if (currentMode === 'bypass') {
      return 'auto';
    }
    // Plan 规则是安全边界而非默认偏好，因此不能被配置或历史审批规则覆盖。
    // Accept edits 会忽略 edit 类 needApproval，并在下方把普通 ask 提升为 allow；
    // 显式 deny 和 external_directory 仍保留，避免自动编辑扩大禁止项或路径边界。
    const needApprovalRules = config.tools.needApproval
      .map(toolNeedApprovalRule)
      .filter(
        (rule) => currentMode !== 'accept-edits' || rule.permission !== 'edit',
      );
    const rules: PermissionRule[] = [
      ...defaultRulesetForMode(currentMode),
      ...(currentMode === 'plan'
        ? []
        : [...config.permissionRules, ...dynamicRules(), ...needApprovalRules]),
    ];

    let needsApproval = false;
    // 先判断工具自身声明；任一 pattern 被拒绝即可短路整次调用。
    for (const pattern of descriptor.patterns) {
      const action = applyModeToAction(
        currentMode,
        descriptor.permission,
        evaluatePermission(rules, descriptor.permission, pattern),
      );
      if (action === 'deny') {
        return buildDecision(
          'denied',
          descriptor,
          [],
          currentMode === 'plan'
            ? `Denied by Plan mode: ${descriptor.permission}`
            : undefined,
        );
      }
      if (action === 'ask') {
        needsApproval = true;
      }
    }

    const externalDirs = externalPaths(
      config.cwd,
      descriptor.paths ?? [],
      descriptor.permission === 'read' || descriptor.permission === 'search'
        ? readRoots()
        : [],
    );
    // 路径越界是独立权限维度；Skill 根目录只放行只读和搜索，不扩大写权限。
    for (const externalDir of externalDirs) {
      const action = evaluatePermission(
        rules,
        'external_directory',
        externalDir,
      );
      if (action === 'deny') {
        return buildDecision(
          'denied',
          descriptor,
          externalDirs,
          currentMode === 'plan'
            ? 'Denied by Plan mode: external_directory'
            : undefined,
        );
      }
      if (action === 'ask') {
        needsApproval = true;
      }
    }

    if (needsApproval) {
      return buildDecision('required', descriptor, externalDirs);
    }
    return 'auto';
  };
}

function applyModeToAction(
  mode: SessionModeState['mode'],
  permission: string,
  action: PermissionRule['action'],
): PermissionRule['action'] {
  return mode === 'accept-edits' && permission === 'edit' && action === 'ask'
    ? 'allow'
    : action;
}

/** 给通用工具提供最小 descriptor，使它们进入同一套权限引擎。 */
export function genericApprovalFor(
  decide: DecideApproval,
): (
  toolName: string,
) => (input: never, ctx: AgentToolContext) => AgentApprovalDecision {
  return (toolName: string) =>
    (input: never, ctx: AgentToolContext): AgentApprovalDecision =>
      decide(
        {
          permission: derivePermission(toolName),
          patterns: [toolName],
          always: [toolName],
          metadata: {
            kind: 'generic',
            inputPreview: previewInput(input),
          },
        },
        ctx,
      );
}

export interface ApprovalPolicyMetadata {
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly always: readonly string[];
  readonly externalDirs?: readonly string[];
  readonly request: PermissionMetadata;
  readonly proxiedTool?: string;
  readonly reason?: string;
}

/** required/denied 的 metadata 是后续 TUI 展示和 RulesStore 落盘的协议。 */
function buildDecision(
  action: 'required' | 'denied',
  descriptor: PermissionDescriptor,
  externalDirs: readonly string[] = [],
  reason?: string,
): AgentApprovalDecision {
  return {
    action,
    metadata: {
      permission: descriptor.permission,
      patterns: descriptor.patterns,
      always: descriptor.always,
      ...(externalDirs.length > 0 ? { externalDirs } : {}),
      ...(reason !== undefined ? { reason } : {}),
      request: descriptor.metadata,
    } satisfies ApprovalPolicyMetadata as unknown as Record<string, unknown>,
  };
}

/** 工具没有声明完整 descriptor 属于编程错误，直接 fail fast。 */
function assertDescriptor(descriptor: PermissionDescriptor): void {
  if (descriptor.permission.length === 0) {
    throw new Error('Permission descriptor has empty permission.');
  }
  if (descriptor.patterns.length === 0) {
    throw new Error(
      `Permission descriptor for ${descriptor.permission} has no patterns.`,
    );
  }
  if (descriptor.always.length === 0) {
    throw new Error(
      `Permission descriptor for ${descriptor.permission} has no always patterns.`,
    );
  }
}

/** tools.needApproval 在运行期规则之后追加，保证普通模式下优先进入审批。 */
function toolNeedApprovalRule(toolName: string): PermissionRule {
  return {
    permission: derivePermission(toolName),
    pattern: '**',
    action: 'ask',
    scope: 'user',
    source: 'tools.needApproval',
  };
}

/** 工具名到权限类别的产品层映射。 */
function derivePermission(toolName: string): string {
  if (toolName === 'read' || toolName === 'ls') return 'read';
  if (toolName === 'grep' || toolName === 'glob') return 'search';
  if (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch')
    return 'edit';
  if (toolName === 'bash') return 'bash';
  if (toolName === 'web_fetch') return 'web_fetch';
  if (toolName.startsWith('task_')) return 'task';
  return toolName;
}

/** 只返回 workspace 外路径，具体是否允许交给 external_directory 规则判定。 */
function externalPaths(
  cwd: string,
  targets: readonly string[],
  readRoots: readonly string[],
): string[] {
  return [
    ...new Set(
      targets.filter(
        (target) =>
          isExternalPath(cwd, target) &&
          !readRoots.some((root) =>
            isPathInside(root, resolveAbsolute(cwd, target)),
          ),
      ),
    ),
  ];
}

function previewInput(input: unknown): string {
  if (input === undefined || input === null) {
    return '-';
  }
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}
