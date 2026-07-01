import path from 'node:path';

import type { ApprovalMode } from '../config/index.js';

import type { PermissionAction, PermissionRule } from './types.js';

/**
 * 权限 pattern 的最小 wildcard 语义。
 *
 * `*` 只匹配单个路径段内的字符，`**` 可跨路径段；这里不引入完整 glob 语法，
 * 避免权限规则出现工具实现无法解释的匹配能力。
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
 */
export function evaluatePermission(
  rules: readonly PermissionRule[],
  permission: string,
  pattern: string,
): PermissionAction {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
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

export function resolveAbsolute(cwd: string, target: string): string {
  return path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(cwd, target);
}

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function isExternalPath(cwd: string, target: string): boolean {
  return !isPathInside(cwd, resolveAbsolute(cwd, target));
}

/**
 * approval mode 只生成最低优先级 default 规则。
 *
 * 显式配置和运行期审批规则仍按 last-match 覆盖它，避免 mode 成为绕过引擎的旁路。
 */
export function defaultRulesetForMode(mode: ApprovalMode): PermissionRule[] {
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
    case 'dont-ask':
    case 'bypass':
      return [allowAll];
    case 'default':
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

/** CLI 和 slash command 展示用的规则表，不参与策略判定。 */
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
