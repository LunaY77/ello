import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { AgentContext } from './context.js';
import type { RunContextLike } from './hooks.js';
import type { ToolsetTool } from './toolsets/index.js';

/** MCP 传输类型。 */
export const MCPTransport = {
  stdio: 'stdio',
  streamableHttp: 'streamable_http',
} as const;

/** MCP 传输类型字符串。 */
export type MCPTransport = (typeof MCPTransport)[keyof typeof MCPTransport];

/** 传输无关的 MCP 服务器规格 schema。 */
export const MCPServerSpecSchema = z.object({
  transport: z
    .enum([MCPTransport.stdio, MCPTransport.streamableHttp])
    .default(MCPTransport.stdio),
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().nullable().default(null),
  headers: z.record(z.string(), z.string()).default({}),
});

/** 带运行时元数据的 MCP 服务器配置 schema。 */
export const MCPServerConfigSchema = MCPServerSpecSchema.extend({
  description: z.string().default(''),
  required: z.boolean().default(true),
});

/** 命名 MCP 服务器配置集合 schema。 */
export const MCPConfigSchema = z.object({
  servers: z.record(z.string(), MCPServerConfigSchema).default({}),
});

/** 传输无关的 MCP 服务器规格。 */
export type MCPServerSpec = z.infer<typeof MCPServerSpecSchema>;

/** 带运行时元数据的 MCP 服务器配置。 */
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/** 命名 MCP 服务器配置集合。 */
export type MCPConfig = z.infer<typeof MCPConfigSchema>;

/**
 * MCP toolset 占位实现。
 *
 * 保存服务器配置和 prefix 信息。真正的 MCP client 连接可在后续接入,
 * 但配置构建和 createAgent wiring 已经与 Python 版保持同样边界。
 */
export class MCPToolset {
  readonly id: string;
  readonly config: MCPServerConfig;
  readonly toolPrefix: string;

  constructor(id: string, config: MCPServerConfig, toolPrefix = id) {
    this.id = id;
    this.config = config;
    this.toolPrefix = toolPrefix;
  }

  /** MCP 工具是否需要审批由具体 MCP server 决定, 本地配置层默认 false。 */
  get hasApprovalTools(): boolean {
    return false;
  }

  /** 当前占位 toolset 不主动暴露工具。 */
  async getTools(
    _ctx: RunContextLike<AgentContext>,
  ): Promise<Record<string, ToolsetTool>> {
    return {};
  }

  /** 当前占位 toolset 不执行工具。 */
  async callTool(): Promise<unknown> {
    return 'Error: MCP tool execution is not connected.';
  }

  /** 返回带命名空间 prefix 的 toolset。 */
  prefixed(prefix: string): MCPToolset {
    return new MCPToolset(this.id, this.config, prefix);
  }
}

/** 从 JSON 文件加载 MCP 配置。 */
export async function loadMcpConfigFile(filePath: string): Promise<MCPConfig> {
  const payload = JSON.parse(await readFile(filePath, 'utf8'));
  return MCPConfigSchema.parse(payload);
}

/** 从配置构建单个 MCP toolset 实例。 */
export function buildMcpServer(
  name: string,
  input: MCPServerConfig,
): MCPToolset | null {
  const config = MCPServerConfigSchema.parse(input);
  if (config.transport === MCPTransport.stdio) {
    if (!config.command) {
      return null;
    }
    return new MCPToolset(name, config).prefixed(name);
  }

  if (config.transport === MCPTransport.streamableHttp) {
    if (!config.url) {
      return null;
    }
    return new MCPToolset(name, config).prefixed(name);
  }

  return null;
}

/** 批量构建 MCP toolset 实例。 */
export function buildMcpServers(mcpConfig: MCPConfig): MCPToolset[] {
  const config = MCPConfigSchema.parse(mcpConfig);
  const servers: MCPToolset[] = [];
  for (const [name, serverConfig] of Object.entries(config.servers)) {
    const server = buildMcpServer(name, serverConfig);
    if (server !== null) {
      servers.push(server);
    }
  }
  return servers;
}
