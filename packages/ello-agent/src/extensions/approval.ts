import type { AgentExtension } from '../public/types.js';

export interface CreateApprovalExtensionOptions {
  readonly mode?: 'never' | 'on-request' | 'always';
}

/**
 * 默认审批扩展占位。
 *
 * 当前审批策略由每个 AgentTool.approval 函数表达；该扩展保留统一装配点，
 * 方便后续把审批 UI、规则引擎或 audit sink 接入 AgentExtension SPI。
 *
 * Args:
 *   options.mode: 预留审批模式。
 *
 * Returns:
 *   AgentExtension。
 */
export function createApprovalExtension(
  options: CreateApprovalExtensionOptions = {},
): AgentExtension {
  return {
    name: 'approval',
    setup() {
      void options;
    },
  };
}
