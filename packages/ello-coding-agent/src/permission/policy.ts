import type { AgentApprovalDecision, AgentToolContext } from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import { applyPermissionPolicy, type PermissionRule } from '../permissions.js';

/**
 * 审批策略工厂。
 *
 * 审批的“暂停/恢复机制”由 `@ello/agent` 的 `approval` hook + deferred/resume
 * 负责，本模块只产出**判定函数**：给定工具名 + 配置 + 当前规则集，返回内核
 * 期望的 `'auto' | 'required' | 'denied'`。
 *
 * 判定逻辑复用 `permissions.ts` 里成熟的 `applyPermissionPolicy`（包含模式短路、
 * 显式规则命中、只读工具放行、accept-edits 放行编辑、重复拒绝降级等分支），
 * 这里只做“按工具名 + 动态规则”的薄封装，方便每个工具在 `defineTool` 里挂上。
 *
 * @param config 当前运行时配置（提供 cwd / allowedPaths / approvalMode）。
 * @param rules  动态规则读取器；通常来自 {@link RulesStore}，每次判定实时取。
 * @param denied 可选的“重复拒绝计数”表，命中阈值后直接 denied（防止模型反复试同一操作）。
 * @returns 一个按工具名生成 approval 函数的高阶函数。
 */
export function makeApprovalPolicy(
  config: CodingAgentConfig,
  rules: () => readonly PermissionRule[],
  denied?: ReadonlyMap<string, number>,
) {
  return (toolName: string) =>
    (input: unknown, _ctx: AgentToolContext): AgentApprovalDecision =>
      applyPermissionPolicy({
        toolName,
        input,
        cwd: config.cwd,
        allowedPaths: config.allowedPaths,
        mode: config.approvalMode,
        rules: [...config.permissionRules, ...rules()],
        ...(denied !== undefined ? { repeatedDenials: denied } : {}),
      });
}
