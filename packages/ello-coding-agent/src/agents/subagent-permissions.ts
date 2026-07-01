import type { PermissionRule } from '../permissions.js';

import type { CodingAgentDefinition } from './schema.js';

/**
 * subagent 默认收紧的工具名集合。
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

function denyToolRule(tool: string): PermissionRule {
  return {
    permission: tool.startsWith('task_') ? 'task' : tool,
    pattern: tool,
    action: 'deny',
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
 * external_directory 规则描述 workspace 外路径授权边界，需要随 parent 一起继承。
 */
export function deriveSubagentPermission(
  parentRules: readonly PermissionRule[],
  def: CodingAgentDefinition,
): readonly PermissionRule[] {
  const tools = def.tools ?? [];
  const canDelegate = tools.includes('delegate_to_subagent');
  const canTask = tools.some((tool) => tool.startsWith('task_'));
  return [
    ...parentRules.filter(
      (rule) =>
        rule.action === 'deny' || rule.permission === 'external_directory',
    ),
    ...(def.permission ?? []),
    ...(canDelegate ? [] : [denyToolRule('delegate_to_subagent')]),
    ...(canTask ? [] : TASK_TOOL_NAMES.map(denyToolRule)),
  ];
}
