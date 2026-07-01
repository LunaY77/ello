import type { PermissionRule } from '../permissions.js';

import type { CodingAgentDefinition } from './schema.js';

/**
 * subagent 默认收紧的工具名集合。
 *
 * matchRule 不支持通配符，所以 `task_*` 必须展开成显式工具名逐条 deny。
 */
const TASK_TOOL_NAMES: readonly string[] = [
  'task_claim',
  'task_create',
  'task_delete',
  'task_get',
  'task_list',
  'task_reset',
  'task_update',
];

function denyRule(tool: string): PermissionRule {
  return {
    action: 'deny',
    tool,
    scope: 'default',
    reason: 'subagent default-deny',
  };
}

/**
 * 派生 subagent sidechain run 的权限规则。
 *
 * 复刻 opencode `deriveSubagentPermission`：子代理**只继承 parent 的 deny**
 * （父 agent 的 allow 只约束父 agent，子 agent 能力由自身定义决定），叠加自身静态
 * permission，并默认禁止递归委派与任务清单写入——除非该 subagent 的 `tools`
 * 白名单显式包含对应工具。
 *
 * 注：当前 PermissionRule 没有 `external_directory` 维度（见 permissions.ts），
 * 因此只继承 `action: 'deny'`，不再继承 opencode 里的 external_directory 规则。
 */
export function deriveSubagentPermission(
  parentRules: readonly PermissionRule[],
  def: CodingAgentDefinition,
): readonly PermissionRule[] {
  const tools = def.tools ?? [];
  const canDelegate = tools.includes('delegate_to_subagent');
  const canTask = tools.some((tool) => tool.startsWith('task_'));
  return [
    ...parentRules.filter((rule) => rule.action === 'deny'),
    ...(def.permission ?? []),
    ...(canDelegate ? [] : [denyRule('delegate_to_subagent')]),
    ...(canTask ? [] : TASK_TOOL_NAMES.map(denyRule)),
  ];
}
