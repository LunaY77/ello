import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { parseTomlConfig, stringifyTomlConfig } from './config-toml.js';
import { PermissionModeSchema, PermissionRuleSchema } from './permissions.js';

export const ApprovalModeSchema = PermissionModeSchema;
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/**
 * coding-agent 产品层的运行时配置。
 *
 * 这个 schema 面向产品侧：核心模型和工具抽象保留在 `@ello/agent`，
 * 当前 package 负责 CLI/TUI 默认值、会话路径、审批姿态和项目级策略。
 */
export const CodingAgentConfigSchema = z.object({
  model: z.string().default('openai-chat:deepseek-v4-flash'),
  modelCandidates: z
    .array(z.string())
    .default([
      'openai-chat:deepseek-v4-flash',
      'openai-chat:gpt-4o-mini',
      'openai-chat:gpt-4.1',
      'openai-chat:gpt-4o',
      'openai-responses:gpt-4.1',
      'anthropic:claude-3-5-sonnet-latest',
    ]),
  baseUrl: z.string().nullable().default(null),
  httpHeaders: z.record(z.string(), z.string()).default({}),
  cwd: z.string().default(process.cwd()),
  allowedPaths: z.array(z.string()).default([]),
  sessionDir: z.string().default(path.join(homedir(), '.ello', 'sessions')),
  sessionId: z.string().nullable().default(null),
  approvalMode: ApprovalModeSchema.default('default'),
  permissionRules: z.array(PermissionRuleSchema).default([]),
  mcpConfigPath: z.string().nullable().default(null),
  systemPromptProfile: z.string().default('coding'),
  theme: z.string().default('default'),
  tui: z.boolean().default(true),
  json: z.boolean().default(false),
});

export type CodingAgentConfig = z.infer<typeof CodingAgentConfigSchema>;
/** 合并前由 CLI 参数、测试或嵌入方传入的局部配置。 */
export type CodingAgentConfigOverrides = Partial<CodingAgentConfig>;

/**
 * 将用户配置、项目配置、环境变量和显式覆盖合并成一份运行时配置。
 *
 * 优先级为：显式覆盖 > 环境变量 > 项目配置文件 > 用户配置文件。
 * 路径类配置会在这里规范化，方便下游会话和权限代码直接比较绝对路径。
 */
export async function loadCodingAgentConfig(
  overrides: CodingAgentConfigOverrides = {},
): Promise<CodingAgentConfig> {
  const cwd = path.resolve(overrides.cwd ?? process.cwd());
  const user = await readConfigFile(path.join(homedir(), '.ello', 'config.toml'));
  const project = await readConfigFile(path.join(cwd, '.ello', 'config.toml'));
  const local = await readConfigFile(path.join(cwd, '.ello', 'local.toml'));
  const env = readEnvConfig();
  const sessionDirValue = firstString(
    overrides.sessionDir,
    env.sessionDir,
    project.sessionDir,
    user.sessionDir,
  );
  const merged = {
    ...user,
    ...project,
    ...local,
    ...env,
    ...overrides,
    cwd,
    allowedPaths: resolveAllowedPaths(
      cwd,
      overrides.allowedPaths ??
        env.allowedPaths ??
        local.allowedPaths ??
        project.allowedPaths ??
        user.allowedPaths,
    ),
    sessionDir: path.resolve(
      sessionDirValue ?? path.join(homedir(), '.ello', 'sessions'),
    ),
  };
  return CodingAgentConfigSchema.parse({
    ...merged,
    approvalMode: normalizeApprovalMode(merged.approvalMode ?? 'default'),
  });
}

/**
 * 返回指定工作目录对应的项目级配置文件路径。
 */
export function getProjectConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), '.ello', 'config.toml');
}

/**
 * 更新单个项目配置键，并重新加载合并后的运行时配置。
 */
export async function setProjectConfigValue(
  cwd: string,
  key: string,
  value: unknown,
): Promise<CodingAgentConfig> {
  const filePath = getProjectConfigPath(cwd);
  const current = await readConfigFile(filePath);
  const next = { ...current, [key]: value };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stringifyTomlConfig(next), 'utf8');
  return loadCodingAgentConfig({ cwd });
}

async function readConfigFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(filePath, 'utf8');
    return filePath.endsWith('.toml')
      ? parseTomlConfig(text)
      : (JSON.parse(text) as Record<string, unknown>);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read config ${filePath}: ${String(error)}`, {
      cause: error,
    });
  }
}

function readEnvConfig(): Record<string, unknown> {
  return {
    ...(process.env.ELLO_MODEL ? { model: process.env.ELLO_MODEL } : {}),
    ...(process.env.ELLO_MODEL_CANDIDATES
      ? { modelCandidates: process.env.ELLO_MODEL_CANDIDATES.split(',') }
      : {}),
    ...(process.env.ELLO_BASE_URL
      ? { baseUrl: process.env.ELLO_BASE_URL }
      : {}),
    ...(process.env.ELLO_HTTP_HEADERS
      ? { httpHeaders: parseJsonObjectEnv('ELLO_HTTP_HEADERS') }
      : {}),
    ...(process.env.ELLO_SESSION_DIR
      ? { sessionDir: process.env.ELLO_SESSION_DIR }
      : {}),
    ...(process.env.ELLO_ALLOWED_PATHS
      ? { allowedPaths: process.env.ELLO_ALLOWED_PATHS.split(path.delimiter) }
      : {}),
    ...(process.env.ELLO_APPROVAL_MODE
      ? { approvalMode: normalizeApprovalMode(process.env.ELLO_APPROVAL_MODE) }
      : {}),
  };
}

/**
 * Normalize configured allowed roots.
 *
 * Empty config means "current workspace only" rather than unrestricted
 * filesystem access. Permission policy can still ask for approval when a tool
 * targets a path outside these roots.
 */
function resolveAllowedPaths(cwd: string, value: unknown): string[] {
  const paths = Array.isArray(value) ? value.filter(isString) : [];
  return (paths.length > 0 ? paths : [cwd]).map((item) =>
    path.isAbsolute(item) ? path.resolve(item) : path.resolve(cwd, item),
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function parseJsonObjectEnv(name: string): Record<string, string> {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  if (value === 'never') return 'dont-ask';
  if (value === 'on-request') return 'default';
  if (value === 'always') return 'bypass';
  return ApprovalModeSchema.parse(value);
}
