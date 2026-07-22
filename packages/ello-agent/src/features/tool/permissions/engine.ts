/**
 * 本文件负责 tool feature 的“engine”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import path from 'node:path';

import type { SessionMode } from './session-mode.js';
import type { PermissionAction, PermissionRule } from './types.js';

/**
 * 权限 pattern 的最小 wildcard 语义。
 *
 * `*` 只匹配单个路径段内的字符，`**` 可跨路径段；这里不引入完整 glob 语法，
 * 避免权限规则出现工具实现无法解释的匹配能力。
 *
 * Args:
 * - `pattern`: `wildcardMatch` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `value`: 要由 `wildcardMatch` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === '**') {
    return true;
  }
  const doubleStar = '\u0000';
  const compiled = pattern
    .replace(/\*\*/gu, doubleStar)
    .replace(/[.+^${}()|[\]\\?]/gu, '\\$&')
    .replace(/\*/gu, '[^/]*')
    .split(doubleStar)
    .join('.*');
  return new RegExp(`^${compiled}$`, 'u').test(value);
}

/**
 * 在合并后的规则集上判定单个 permission/pattern。
 *
 * 最后匹配生效：调用方按 default -> config -> user -> project -> session 拼接规则，
 * 越靠后的规则越接近当前用户决策，可以覆盖内置 default；同一来源里写在后面的
 * 更具体规则也能覆盖前面的泛规则。没有命中时默认 ask，让未声明状态显式进入审批。
 *
 * Args:
 * - `rules`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 * - `permission`: `evaluatePermission` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `pattern`: `evaluatePermission` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `evaluatePermission` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function evaluatePermission(
  rules: readonly PermissionRule[],
  permission: string,
  pattern: string,
): PermissionAction {
  for (const rule of [...rules].reverse()) {
    if (rule.permission !== '*' && rule.permission !== permission) {
      continue;
    }
    if (!wildcardMatch(rule.pattern, pattern)) {
      continue;
    }
    return rule.action;
  }
  return 'ask';
}

/**
 * 在 工具 `engine` 模块 中执行 `resolveAbsolute` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `target`: `resolveAbsolute` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `resolveAbsolute` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `engine` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function resolveAbsolute(cwd: string, target: string): string {
  return path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(cwd, target);
}

/**
 * 执行 工具 `engine` 模块 定义的 `isPathInside` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `root`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `target`: `isPathInside` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
 */
export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * 执行 工具 `engine` 模块 定义的 `isExternalPath` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `target`: `isExternalPath` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
 */
export function isExternalPath(cwd: string, target: string): boolean {
  return !isPathInside(cwd, resolveAbsolute(cwd, target));
}

/**
 * 为会话模式生成完整的基础权限表。
 *
 * 非 Plan 模式仍可在 policy 层叠加配置和运行期规则；Plan 模式则使用封闭规则集，
 * 明确拒绝 edit/bash/web/external，避免一条历史 allow 规则把只读边界重新打开。
 *
 * Args:
 * - `mode`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function defaultRulesetForMode(mode: SessionMode): PermissionRule[] {
  const rule = (
    permission: string,
    action: PermissionAction,
  ): PermissionRule => ({
    permission,
    pattern: '**',
    action,
    scope: 'default',
    source: `mode:${mode}`,
  });
  const allowAll: PermissionRule = {
    permission: '*',
    pattern: '**',
    action: 'allow',
    scope: 'default',
    source: `mode:${mode}`,
  };
  switch (mode) {
    case 'plan':
      return [
        rule('read', 'allow'),
        rule('search', 'allow'),
        rule('edit', 'deny'),
        rule('bash', 'deny'),
        rule('web_fetch', 'deny'),
        rule('external_directory', 'deny'),
        rule('task', 'ask'),
      ];
    case 'accept-edits':
      return [
        rule('read', 'allow'),
        rule('search', 'allow'),
        rule('edit', 'allow'),
        rule('bash', 'ask'),
        rule('web_fetch', 'ask'),
        rule('external_directory', 'ask'),
        rule('task', 'ask'),
      ];
    case 'bypass':
      return [allowAll];
    case 'ask-before-changes':
      return [
        rule('read', 'allow'),
        rule('search', 'allow'),
        rule('edit', 'ask'),
        rule('bash', 'ask'),
        rule('web_fetch', 'ask'),
        rule('external_directory', 'ask'),
        rule('task', 'ask'),
      ];
  }
}

/**
 * CLI 和 slash command 展示用的规则表，不参与策略判定。
 *
 * Args:
 * - `rules`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `formatPermissionRules` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function formatPermissionRules(
  rules: readonly PermissionRule[],
): string {
  if (rules.length === 0) {
    return 'rules\t<none>';
  }
  return rules
    .map((rule) =>
      [
        rule.action.padEnd(5),
        rule.permission.padEnd(18),
        rule.pattern.padEnd(24),
        `scope=${rule.scope}`,
      ].join('\t'),
    )
    .join('\n');
}
