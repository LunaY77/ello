/**
 * 本文件负责 agent feature 的“subagent-permissions”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { PermissionRule } from '../../config/index.js';

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
 *
 * Args:
 * - `parentRules`: `deriveSubagentPermission` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `def`: `deriveSubagentPermission` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function deriveSubagentPermission(
  parentRules: readonly PermissionRule[],
  def: CodingAgentDefinition,
): readonly PermissionRule[] {
  const canDelegate =
    def.tools !== undefined && def.tools.includes('delegate_to_subagent');
  const canTask =
    def.tools !== undefined &&
    def.tools.some((tool) => tool.startsWith('task_'));
  return [
    ...parentRules.filter(
      (rule) =>
        rule.action === 'deny' || rule.permission === 'external_directory',
    ),
    ...(def.permission === undefined ? [] : def.permission),
    ...(canDelegate ? [] : [denyToolRule('delegate_to_subagent')]),
    ...(canTask ? [] : TASK_TOOL_NAMES.map(denyToolRule)),
  ];
}
