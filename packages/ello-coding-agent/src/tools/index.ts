import type { AnyAgentTool } from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import { makeApprovalPolicy } from '../permission/policy.js';
import type { PermissionRule } from '../permissions.js';

import { createFsTools } from './fs.js';
import { createSearchTools } from './search.js';
import type { ApprovalFor } from './shared.js';
import { createShellTools } from './shell.js';
import { createTaskTools } from './task.js';
import { canFetch, webFetchTool } from './web.js';

/**
 * coding 工具集装配。
 *
 * 工具只做两件事：**纯执行** + **声明审批策略**。schema 校验、调度/并行、
 * 权限触发、事件发射全部由 `@ello/agent` 负责。审批策略来自 06 的
 * {@link makeApprovalPolicy}（按工具名 + 动态规则实时判定）。
 */
export interface CreateCodingToolsOptions {
  readonly config: CodingAgentConfig;
  /** 动态权限规则读取器（来自 06 的 RulesStore）。 */
  readonly rules?: () => readonly PermissionRule[];
  /** 重复拒绝计数表，命中阈值后直接 denied。 */
  readonly denied?: ReadonlyMap<string, number>;
}

/**
 * 创建 coding-agent 默认工具集。
 *
 * 按域拆分：fs / search / shell / task；`web_fetch` 仅在可联网时注册。
 */
export function createCodingTools(options: CreateCodingToolsOptions): AnyAgentTool[] {
  const { config } = options;
  const approval: ApprovalFor = makeApprovalPolicy(
    config,
    options.rules ?? (() => []),
    options.denied,
  );

  return [
    ...createFsTools(config, approval),
    ...createSearchTools(config, approval),
    ...createShellTools(config, approval),
    ...createTaskTools(config, approval),
    ...(canFetch(config) ? [webFetchTool(approval)] : []),
  ];
}

/** 生成工具列表的 CLI 视图（`ello tools` 与 `/tools` 用）。 */
export function describeCodingTools(): string {
  return [
    'read\tread file with line numbers',
    'ls\tlist directory',
    'grep\tsearch text with ripgrep',
    'glob\tmatch file paths',
    'write\tcreate or overwrite file',
    'edit\tunique text replacement',
    'bash\trun shell command',
    'todo\tupdate task panel',
    'web_fetch\tfetch URL',
  ].join('\n');
}

export type { ApprovalFor } from './shared.js';
