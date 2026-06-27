import type { AgentTool } from '../public/types.js';

export interface CreateMcpToolsOptions {
  readonly config?: unknown;
}

/**
 * 创建 MCP 工具。
 *
 * 当前是占位实现：旧 MCPToolset 已随旧架构删除。新架构下 MCP server
 * 应适配为 AgentTool 后返回。
 *
 * Args:
 *   options.config: 预留 MCP 配置。
 *
 * Returns:
 *   当前返回空数组。
 */
export function createMcpTools(_options: CreateMcpToolsOptions = {}): AgentTool<any, unknown>[] {
  return [];
}
