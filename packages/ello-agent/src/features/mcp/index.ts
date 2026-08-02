/**
 * 本文件是 MCP feature 的公开入口。
 *
 * 其他 feature 只能通过这里创建连接管理器或解析 MCP 配置路径。
 */
export {
  loadMcpConfig,
  resolveMcpConfigPath,
  McpConfigSchema,
  McpServerConfigSchema,
  type LoadedMcpConfig,
  type McpConfig,
  type McpServerConfig,
} from './config.js';
export { McpManager } from './manager.js';
