/**
 * 本文件负责读取和校验 MCP 服务器配置。
 *
 * 配置文件使用 JSON 格式。未指定路径时读取全局 `mcp.json`；相对路径按项目工作目录解析，
 * 服务器的工作目录则按 MCP 配置文件所在目录解析。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { globalMcpPath, type CodingAgentConfig } from '../config/index.js';

const McpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(
    /^[A-Za-z0-9_-]+$/u,
    'MCP server names may contain only letters, digits, underscores, and hyphens.',
  );

const CommonServerFields = {
  enabled: z.boolean().default(true),
  timeout_ms: z.number().int().min(1_000).max(600_000).default(60_000),
} as const;

const McpStdioServerConfigSchema = z
  .object({
    ...CommonServerFields,
    type: z.literal('stdio').optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
  })
  .strict();

const McpHttpServerConfigSchema = z
  .object({
    ...CommonServerFields,
    type: z.enum(['http', 'streamable-http']).optional(),
    url: z
      .url()
      .refine(
        (value) => ['http:', 'https:'].includes(new URL(value).protocol),
        {
          message: 'MCP HTTP URLs must use http or https.',
        },
      ),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const McpServerConfigSchema = z.union([
  McpStdioServerConfigSchema,
  McpHttpServerConfigSchema,
]);

export const McpConfigSchema = z
  .object({
    servers: z.record(McpServerNameSchema, McpServerConfigSchema).default({}),
  })
  .strict();

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

export interface LoadedMcpConfig {
  readonly path: string;
  readonly directory: string;
  readonly config: McpConfig;
}

/** 解析 MCP 配置文件的绝对路径。 */
export function resolveMcpConfigPath(
  config: Pick<CodingAgentConfig, 'cwd' | 'mcp_config_path'>,
): string {
  const configured = config.mcp_config_path?.trim();
  if (!configured) return globalMcpPath();
  const expanded = expandHome(configured);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(config.cwd, expanded);
}

/** 读取并校验 MCP 配置文件。 */
export async function loadMcpConfig(
  config: Pick<CodingAgentConfig, 'cwd' | 'mcp_config_path'>,
): Promise<LoadedMcpConfig> {
  const configPath = resolveMcpConfigPath(config);
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read MCP config '${configPath}'.`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`MCP config '${configPath}' is not valid JSON.`, {
      cause: error,
    });
  }
  const parsed = McpConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`MCP config '${configPath}' is invalid: ${issues}`, {
      cause: parsed.error,
    });
  }
  return {
    path: configPath,
    directory: path.dirname(configPath),
    config: parsed.data,
  };
}

/** 解析 stdio MCP 服务器的工作目录。 */
export function resolveMcpServerCwd(
  configDirectory: string,
  configuredCwd: string | undefined,
): string | undefined {
  if (configuredCwd === undefined) return undefined;
  const expanded = expandHome(configuredCwd);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(configDirectory, expanded);
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}
