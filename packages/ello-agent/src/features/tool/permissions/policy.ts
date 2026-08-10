/**
 * 本文件负责 tool feature 的“policy”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  CommandApprovalDecision,
  CommandContext,
  MaybePromise,
} from '../../command/index.js';
import type { CodingAgentConfig } from '../../config/index.js';

import {
  defaultRulesetForMode,
  evaluatePermission,
  isExternalPath,
  isPathInside,
  resolveAbsolute,
} from './engine.js';
import type { SessionModeState } from './session-mode.js';
import type {
  PermissionDescriptor,
  PermissionMetadata,
  PermissionRule,
} from './types.js';

/**
 * 执行 工具 `policy` 模块 定义的 `DecideApproval` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `descriptor`: `DecideApproval` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `ctx`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 *
 * Returns:
 * - 返回 `DecideApproval` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export type DecideApproval = (
  descriptor: PermissionDescriptor,
  ctx: CommandContext,
  options?: DecideApprovalOptions,
) => CommandApprovalDecision;

export interface DecideApprovalOptions {
  /** 只判定路径是否已获 external_directory 授权，不判定工具自身权限。 */
  readonly externalPathsOnly?: boolean;
}

/**
 * 执行 Command `policy` 模块定义的 `ApprovalFor` 领域操作。
 *
 * Args:
 * - `commandName`: 需要创建审批回调的 Command 名称。
 *
 * Returns:
 * - 返回 `ApprovalFor` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export type ApprovalFor = (
  commandName: string,
) => (
  input: unknown,
  ctx: CommandContext,
) => MaybePromise<CommandApprovalDecision>;

/**
 * 把 Command 声明的 PermissionDescriptor 判定成 @ello/agent 的审批动作。
 *
 * 判定顺序是：先看工具自身 permission/pattern，再看 paths 派生出的
 * external_directory；任一 deny 直接拒绝，存在 ask 则进入人工审批。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 * - `dynamicRules`: `makeApprovalPolicy` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `mode`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
 * - `readRoots`: `makeApprovalPolicy` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - 返回 `makeApprovalPolicy` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function makeApprovalPolicy(
  config: CodingAgentConfig,
  dynamicRules: () => readonly PermissionRule[],
  mode: () => SessionModeState,
  readRoots: () => readonly string[] = () => [],
): DecideApproval {
  return (
    descriptor: PermissionDescriptor,
    _ctx: CommandContext,
    options: DecideApprovalOptions = {},
  ): CommandApprovalDecision => {
    assertDescriptor(descriptor);
    const currentMode = mode().mode;
    const boundaryRules = dynamicRules().filter(
      (rule) => rule.action === 'deny',
    );
    const externalDirs = externalPaths(
      config.cwd,
      descriptor.paths ?? [],
      config.allowed_paths,
      descriptor.permission === 'read' || descriptor.permission === 'search'
        ? readRoots()
        : [],
    );
    // definition、父级 deny 与路径边界始终先于会话模式，bypass 也不能扩大 child 能力。
    if (
      descriptor.patterns.some(
        (pattern) =>
          evaluatePermission(boundaryRules, descriptor.permission, pattern) ===
          'deny',
      ) ||
      externalDirs.some(
        (externalDir) =>
          evaluatePermission(
            boundaryRules,
            'external_directory',
            externalDir,
          ) === 'deny',
      )
    ) {
      return buildDecision('denied', descriptor, externalDirs);
    }
    // Bypass 只跳过普通审批，前面的硬边界仍然有效。
    if (currentMode === 'bypass') return 'auto';
    // Plan 规则是安全边界而非默认偏好，因此不能被配置或历史审批规则覆盖。
    // Accept edits 会忽略 edit 类 need_approval，并在下方把普通 ask 提升为 allow；
    // 显式 deny 和 external_directory 仍保留，避免自动编辑扩大禁止项或路径边界。
    const needApprovalRules = config.commands.need_approval
      .map(commandNeedApprovalRule)
      .filter(
        (rule) => currentMode !== 'accept-edits' || rule.permission !== 'edit',
      );
    const rules: PermissionRule[] = [
      ...defaultRulesetForMode(currentMode),
      ...(currentMode === 'plan'
        ? []
        : [
            ...config.permission_rules,
            ...dynamicRules(),
            ...needApprovalRules,
          ]),
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
      if (action === 'ask' && options.externalPathsOnly !== true) {
        needsApproval = true;
      }
    }

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

/**
 * 给通用工具提供最小 descriptor，使它们进入同一套权限引擎。
 *
 * Args:
 * - `decide`: `genericApprovalFor` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `genericApprovalFor` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function genericApprovalFor(decide: DecideApproval): ApprovalFor {
  return (commandName: string) =>
    (input: unknown, ctx: CommandContext): CommandApprovalDecision =>
      decide(
        {
          permission: derivePermission(commandName),
          patterns: [commandName],
          always: [commandName],
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
  readonly reason?: string;
}

/** required/denied 的 metadata 是后续 TUI 展示和 RulesStore 落盘的协议。 */
function buildDecision(
  action: 'required' | 'denied',
  descriptor: PermissionDescriptor,
  externalDirs: readonly string[] = [],
  reason?: string,
): CommandApprovalDecision {
  const metadata = {
    permission: descriptor.permission,
    patterns: descriptor.patterns,
    always: descriptor.always,
    ...(externalDirs.length > 0 ? { externalDirs } : {}),
    ...(reason !== undefined ? { reason } : {}),
    request: descriptor.metadata,
  } satisfies ApprovalPolicyMetadata;
  return {
    action,
    metadata,
  };
}

/** Command 没有声明完整 descriptor 属于编程错误，直接 fail fast。 */
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

/** commands.need_approval 在运行期规则之后追加，保证普通模式下优先进入审批。 */
function commandNeedApprovalRule(commandName: string): PermissionRule {
  return {
    permission: derivePermission(commandName),
    pattern: '**',
    action: 'ask',
    scope: 'user',
    source: 'commands.need_approval',
  };
}

/** Command 名到权限类别的产品层映射。 */
function derivePermission(commandName: string): string {
  if (commandName === 'read' || commandName === 'ls') return 'read';
  if (commandName === 'search') return 'search';
  if (commandName === 'memory_read' || commandName === 'memory_list')
    return 'read';
  if (commandName === 'memory_search') return 'search';
  if (
    commandName === 'write' ||
    commandName === 'edit' ||
    commandName === 'apply_patch'
  )
    return 'edit';
  if (commandName === 'memory_write' || commandName === 'memory_delete')
    return 'edit';
  if (commandName === 'bash') return 'bash';
  if (commandName === 'web_fetch') return 'web_fetch';
  if (commandName.startsWith('mcp__')) return 'mcp';
  if (commandName.startsWith('task_')) return 'task';
  return commandName;
}

/** 只返回 workspace 外路径，具体是否允许交给 external_directory 规则判定。 */
function externalPaths(
  cwd: string,
  targets: readonly string[],
  authorizedRoots: readonly string[],
  readRoots: readonly string[],
): string[] {
  return [
    ...new Set(
      targets.filter(
        (target) =>
          isExternalPath(cwd, target) &&
          !authorizedRoots.some((root) =>
            isPathInside(
              resolveAbsolute(cwd, root),
              resolveAbsolute(cwd, target),
            ),
          ) &&
          !readRoots.some((root) =>
            isPathInside(
              resolveAbsolute(cwd, root),
              resolveAbsolute(cwd, target),
            ),
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
