import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { builtinProviderCatalog } from '../agent/providers/catalog/catalog.js';
import { validateProviderCatalog } from '../agent/providers/catalog/registry.js';

import { atomicWriteText } from './atomic-write.js';
import { ensureBuiltinAssets, ensureGlobalConfig } from './initializer.js';
import { globalConfigPath, globalHomeDir, projectConfigPath } from './paths.js';
import {
  CodingAgentConfigSchema,
  type CodingAgentConfig,
  type CodingAgentConfigOverrides,
} from './schema.js';
import {
  deleteYamlConfigValues,
  parseYamlConfig,
  updateYamlConfigValues,
} from './yaml.js';

export type ConfigSourceName = 'defaults' | 'global' | 'project' | 'override';

export interface LoadedConfigSource {
  readonly name: ConfigSourceName;
  readonly path?: string;
  readonly data: Record<string, unknown>;
}

export type WritableConfigSourceName = 'global' | 'project';

export class ConfigValidationError extends Error {
  readonly issues: readonly unknown[];

  constructor(
    message: string,
    issues: readonly unknown[],
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/**
 * 读取并合并 coding-agent 配置。
 *
 * 配置来源：全局 `~/.ello/config.yaml`、项目 `.ello/config.yaml`、
 * 以及 CLI/测试传入的 runtime overrides。模型配置只接受 provider/models/profile
 * 三层结构。
 */
export async function loadCodingAgentConfig(
  overrides: CodingAgentConfigOverrides = {},
): Promise<CodingAgentConfig> {
  await ensureGlobalConfig();
  await ensureBuiltinAssets();
  const cwd = path.resolve(overrides.cwd ?? process.cwd());
  const [userConfig, projectConfig] = await Promise.all([
    readConfigFile(globalConfigPath()),
    readConfigFile(projectConfigPath(cwd)),
  ]);
  return resolveCodingAgentConfig(cwd, userConfig, projectConfig, overrides);
}

function resolveCodingAgentConfig(
  cwd: string,
  userConfig: Record<string, unknown>,
  projectConfig: Record<string, unknown>,
  overrides: CodingAgentConfigOverrides,
): CodingAgentConfig {
  rejectProjectProfileConfig(projectConfig, projectConfigPath(cwd));
  const defaults = {
    provider: builtinProviderCatalog.provider,
    models: builtinProviderCatalog.models,
    profile: builtinProviderCatalog.profile,
  };
  const sessionDirValue = firstString(
    overrides.session_dir,
    projectConfig.session_dir,
    userConfig.session_dir,
  );
  // 合并顺序由低到高：global -> project -> runtime overrides。
  const merged = mergeConfigLayers(
    defaults,
    userConfig,
    projectConfig,
    overrides,
    {
      cwd,
      allowed_paths: resolveAllowedPaths(
        cwd,
        overrides.allowed_paths ??
          projectConfig.allowed_paths ??
          userConfig.allowed_paths,
      ),
      session_dir: path.resolve(
        sessionDirValue ?? path.join(homedir(), '.ello', 'sessions'),
      ),
    },
  );
  const result = CodingAgentConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigValidationError(
      `Coding agent configuration does not match the config schema: ${formatConfigIssues(result.error.issues)}`,
      result.error.issues,
      { cause: result.error },
    );
  }
  const parsed = result.data;
  const resolved = {
    ...parsed,
    context: {
      ...parsed.context,
      memory: {
        ...parsed.context.memory,
        private_dir: resolveMemoryPath(
          cwd,
          parsed.context.memory.private_dir,
          path.join(globalHomeDir(), 'memory', 'private'),
        ),
        team_dir: resolveMemoryPath(
          cwd,
          parsed.context.memory.team_dir,
          path.join(cwd, '.ello', 'memory', 'team'),
        ),
      },
    },
  };
  try {
    validateProviderCatalog(resolved);
  } catch (error) {
    throw new ConfigValidationError(
      `Coding agent provider catalog is invalid: ${errorMessage(error)}`,
      [{ path: [], message: errorMessage(error), source: 'merged' }],
      { cause: error },
    );
  }
  return resolved;
}

/** 返回配置来源列表，供 `ello config sources` 展示和调试合并顺序。 */
export async function loadConfigSources(
  cwdInput = process.cwd(),
  overrides: Record<string, unknown> = {},
): Promise<readonly LoadedConfigSource[]> {
  const cwd = path.resolve(cwdInput);
  return [
    { name: 'defaults', data: {} },
    {
      name: 'global',
      path: globalConfigPath(),
      data: await readConfigFile(globalConfigPath()),
    },
    {
      name: 'project',
      path: projectConfigPath(cwd),
      data: await readConfigFile(projectConfigPath(cwd)),
    },
    { name: 'override', data: overrides },
  ];
}

/** 项目配置路径 */
export function getProjectConfigPath(cwd: string): string {
  return projectConfigPath(cwd);
}

/** 读取 merged 或指定 source 的配置值，支持带引号的 dotted key。 */
export async function getConfigValue(
  cwd: string,
  key: string | undefined,
  source: ConfigSourceName | 'merged' = 'merged',
): Promise<unknown> {
  if (source === 'merged') {
    const config = await loadCodingAgentConfig({ cwd });
    return key === undefined
      ? config
      : getDeepValue(config as unknown as Record<string, unknown>, key);
  }
  const selected = (await loadConfigSources(cwd)).find(
    (item) => item.name === source,
  );
  const data = selected?.data ?? {};
  return key === undefined ? data : getDeepValue(data, key);
}

/** 写入 global/project 配置文件，value 已由 CLI 层解析成 YAML 可表示的值。 */
export async function setConfigValue(
  cwd: string,
  source: WritableConfigSourceName,
  key: string,
  value: unknown,
): Promise<CodingAgentConfig> {
  return setConfigValues(cwd, source, [{ key, value }]);
}

/** 原子写入同一个配置文件中的多个 dotted key。 */
export async function setConfigValues(
  cwd: string,
  source: WritableConfigSourceName,
  entries: readonly { readonly key: string; readonly value: unknown }[],
): Promise<CodingAgentConfig> {
  await ensureGlobalConfig();
  const filePath =
    source === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const current = await readConfigText(filePath);
  const next = updateYamlConfigValues(
    current,
    entries.map((entry) => ({
      path: parseDottedKey(entry.key),
      value: entry.value,
    })),
  );
  return validateAndCommitConfig(cwd, source, filePath, next);
}

/** 原子删除同一个配置文件中的多个 dotted key。 */
export async function deleteConfigValues(
  cwd: string,
  source: WritableConfigSourceName,
  keys: readonly string[],
): Promise<CodingAgentConfig> {
  await ensureGlobalConfig();
  const filePath =
    source === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const current = await readConfigText(filePath);
  const next = deleteYamlConfigValues(
    current,
    keys.map((key) => parseDottedKey(key)),
  );
  return validateAndCommitConfig(cwd, source, filePath, next);
}

/** RPC 已经把 key 解析成 path segment；这里不再把带点的 segment 二次拆分。 */
export async function writeConfigPath(
  cwd: string,
  source: WritableConfigSourceName,
  configPath: readonly string[],
  operation:
    | { readonly type: 'set'; readonly value: unknown }
    | { readonly type: 'delete' },
): Promise<CodingAgentConfig> {
  if (configPath.length === 0 || configPath.some((segment) => segment === '')) {
    throw new Error('Config path must contain non-empty segments.');
  }
  await ensureGlobalConfig();
  const filePath =
    source === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const current = await readConfigText(filePath);
  const next =
    operation.type === 'set'
      ? updateYamlConfigValues(current, [
          { path: configPath, value: operation.value },
        ])
      : deleteYamlConfigValues(current, [configPath]);
  return validateAndCommitConfig(cwd, source, filePath, next);
}

/** 先校验候选合并结果，再替换文件，避免失败请求把可用配置改成损坏状态。 */
async function validateAndCommitConfig(
  cwdInput: string,
  source: WritableConfigSourceName,
  filePath: string,
  next: string,
): Promise<CodingAgentConfig> {
  const cwd = path.resolve(cwdInput);
  const candidate = parseYamlConfig(next);
  const [userConfig, projectConfig] = await Promise.all([
    source === 'global'
      ? Promise.resolve(candidate)
      : readConfigFile(globalConfigPath()),
    source === 'project'
      ? Promise.resolve(candidate)
      : readConfigFile(projectConfigPath(cwd)),
  ]);
  const config = resolveCodingAgentConfig(cwd, userConfig, projectConfig, {
    cwd,
  });
  await atomicWriteText(filePath, next);
  return config;
}

/** 不存在的配置文件按空对象处理，方便项目配置按需创建。 */
async function readConfigFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read config ${filePath}: ${String(error)}`, {
      cause: error,
    });
  }
  try {
    return parseYamlConfig(text);
  } catch (error) {
    throw new ConfigValidationError(
      `Invalid YAML config ${filePath}: ${errorMessage(error)}`,
      [{ path: [], message: errorMessage(error), source: filePath }],
      { cause: error },
    );
  }
}

/** 默认允许 cwd；相对路径以 cwd 为基准解析成绝对路径。 */
function resolveAllowedPaths(cwd: string, value: unknown): string[] {
  const paths = Array.isArray(value) ? value.filter(isString) : [];
  return (paths.length > 0 ? paths : [cwd]).map((item) =>
    path.isAbsolute(item) ? path.resolve(item) : path.resolve(cwd, item),
  );
}

function resolveMemoryPath(
  cwd: string,
  value: string,
  defaultPath: string,
): string {
  if (value === '~/.ello/memory/private' || value === '.ello/memory/team') {
    return path.resolve(defaultPath);
  }
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/')) {
    return path.resolve(homedir(), value.slice(2));
  }
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(cwd, value);
}

async function readConfigText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw new Error(`Failed to read config ${filePath}: ${String(error)}`, {
      cause: error,
    });
  }
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

function mergeConfigLayers(
  ...layers: readonly Record<string, unknown>[]
): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (const layer of layers) {
    result = mergePlainRecord(result, layer);
  }
  return result;
}

function mergePlainRecord(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (key === 'profile' && isPlainRecord(value)) {
      result[key] = value;
      continue;
    }
    result[key] =
      isPlainRecord(existing) && isPlainRecord(value)
        ? mergePlainRecord(existing, value)
        : value;
  }
  return result;
}

function rejectProjectProfileConfig(
  projectConfig: Record<string, unknown>,
  filePath: string,
): void {
  if (projectConfig.profile !== undefined) {
    throw projectConfigKeyError('profile', filePath);
  }
  if (projectConfig.active_profile !== undefined) {
    throw projectConfigKeyError('active_profile', filePath);
  }
  if (projectConfig.default_agent !== undefined) {
    throw projectConfigKeyError('default_agent', filePath);
  }
}

function projectConfigKeyError(
  key: string,
  filePath: string,
): ConfigValidationError {
  const message = `Project config must not define ${key}: ${filePath}`;
  return new ConfigValidationError(message, [
    { path: [key], message, source: filePath },
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatConfigIssues(
  issues: readonly { readonly path: PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) => {
      const configPath = issue.path.map(String).join('.');
      return `${configPath.length > 0 ? configPath : '<root>'}: ${issue.message}`;
    })
    .join('; ');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析 dotted key；引号内的点不作为层级分隔符。 */
function parseDottedKey(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '.') {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/** 读取 dotted key，和 setDeepValue 使用同一套 quoted segment 规则。 */
function getDeepValue(
  value: Record<string, unknown>,
  dottedKey: string,
): unknown {
  let current: unknown = value;
  for (const part of parseDottedKey(dottedKey)) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
