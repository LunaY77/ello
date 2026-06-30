import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { parseTomlConfig, stringifyTomlConfig } from '../utils/toml.js';

import { ensureBuiltinAssets, ensureGlobalConfig } from './initializer.js';
import { globalConfigPath, projectConfigPath } from './paths.js';
import {
  ApprovalModeSchema,
  CodingAgentConfigSchema,
  ModelProfileSchema,
  ModelProviderSchema,
  type CodingAgentConfig,
  type CodingAgentConfigOverrides,
  type ModelProfileConfig,
  type ModelProviderConfig,
} from './schema.js';

export type ConfigSourceName = 'defaults' | 'global' | 'project' | 'override';

export interface LoadedConfigSource {
  readonly name: ConfigSourceName;
  readonly path?: string;
  readonly data: Record<string, unknown>;
}

export type WritableConfigSourceName = 'global' | 'project';

/**
 * 读取并合并 coding-agent 配置。
 *
 * 配置来源：全局 `~/.ello/config.toml`、项目 `.ello/config.toml`、
 * 以及 CLI/测试传入的 runtime overrides。provider 的 `env_key` 用于读取模型密钥。
 */
export async function loadCodingAgentConfig(
  overrides: CodingAgentConfigOverrides = {},
): Promise<CodingAgentConfig> {
  await ensureGlobalConfig();
  await ensureBuiltinAssets();
  const cwd = path.resolve(overrides.cwd ?? process.cwd());
  const user = await readConfigFile(globalConfigPath());
  const project = await readConfigFile(projectConfigPath(cwd));
  const userConfig = normalizeConfigNamespace(user);
  const projectConfig = normalizeConfigNamespace(project);
  const sessionDirValue = firstString(
    overrides.sessionDir,
    projectConfig.sessionDir,
    userConfig.sessionDir,
  );
  // 合并顺序由低到高：global -> project -> runtime overrides。
  const merged = {
    ...userConfig,
    ...projectConfig,
    ...overrides,
    cwd,
    allowedPaths: resolveAllowedPaths(
      cwd,
      overrides.allowedPaths ??
        projectConfig.allowedPaths ??
        userConfig.allowedPaths,
    ),
    sessionDir: path.resolve(
      sessionDirValue ?? path.join(homedir(), '.ello', 'sessions'),
    ),
  };
  return CodingAgentConfigSchema.parse({
    ...merged,
    approvalMode: normalizeApprovalMode(merged.approvalMode ?? 'default'),
    ...resolveModelProfileRuntimeConfig(merged),
    ...resolveRuntimeModelOverrides(overrides),
  });
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

/** 写入 global/project 配置文件，value 已由 CLI 层解析成 TOML 可表示的值。 */
export async function setConfigValue(
  cwd: string,
  source: WritableConfigSourceName,
  key: string,
  value: unknown,
): Promise<CodingAgentConfig> {
  const filePath =
    source === 'global' ? globalConfigPath() : projectConfigPath(cwd);
  const current = await readConfigFile(filePath);
  const next = setDeepValue(current, key, value);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, stringifyTomlConfig(next), 'utf8');
  return loadCodingAgentConfig({ cwd });
}

/** 不存在的配置文件按空对象处理，方便项目配置按需创建。 */
async function readConfigFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(filePath, 'utf8');
    return parseTomlConfig(text);
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

/**
 * 支持模板里的 `[ello]` 分组。
 *
 * TOML 顶层在第一个表头后不能再继续写普通 key；模型配置必须放在最顶端，所以
 * 非模型运行配置统一放入 `[ello]`。loader 在这里把它平铺回运行时配置对象。
 */
function normalizeConfigNamespace(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const ello =
    typeof value.ello === 'object' &&
    value.ello !== null &&
    !Array.isArray(value.ello)
      ? (value.ello as Record<string, unknown>)
      : {};
  const { ello: _ello, ...rest } = value;
  return { ...rest, ...ello };
}

/** 默认允许 cwd；相对路径以 cwd 为基准解析成绝对路径。 */
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

/**
 * 从 model profile 和 provider 派生运行时模型配置。
 *
 * - `default_model_profile` 决定启动时默认模型档案；
 * - `model_profiles.*.model` 决定协议和模型 ID；
 * - `model_providers.*` 决定 base URL、API key env 名和 HTTP headers；
 * - `modelCandidates` 是给现有 TUI 补全/选择用的派生列表。
 */
function resolveModelProfileRuntimeConfig(
  rawConfig: Record<string, unknown>,
): Partial<
  Pick<
    CodingAgentConfig,
    | 'model'
    | 'model_provider'
    | 'model_reasoning_effort'
    | 'personality'
    | 'baseUrl'
    | 'apiKey'
    | 'httpHeaders'
    | 'modelCandidates'
  >
> {
  const modelProfiles = parseModelProfiles(rawConfig.model_profiles);
  const selectedProfileName =
    nonEmptyString(rawConfig.model_profile) ??
    nonEmptyString(rawConfig.default_model_profile);
  const selectedProfile =
    selectedProfileName !== null
      ? modelProfiles[selectedProfileName]
      : undefined;
  const explicitProviderName = nonEmptyString(selectedProfile?.model_provider);
  const explicitModel = nonEmptyString(selectedProfile?.model);
  const modelCandidatesFromProfiles = Object.values(modelProfiles).map(
    (profile) => profile.model,
  );
  const providers = rawConfig.model_providers;
  const provider =
    explicitProviderName !== null &&
    typeof providers === 'object' &&
    providers !== null &&
    !Array.isArray(providers)
      ? (providers as Record<string, unknown>)[explicitProviderName]
      : undefined;
  const providerConfig = parseModelProvider(provider);
  const baseUrl =
    nonEmptyString(rawConfig.baseUrl) ??
    nonEmptyString(providerConfig?.base_url);
  const apiKey =
    nonEmptyString(rawConfig.apiKey) ??
    (providerConfig?.env_key !== undefined
      ? nonEmptyString(process.env[providerConfig.env_key])
      : null);
  const httpHeaders =
    Object.keys(providerConfig?.http_headers ?? {}).length > 0
      ? providerConfig!.http_headers
      : parseStringRecord(rawConfig.httpHeaders);

  const next: Partial<
    Pick<
      CodingAgentConfig,
      | 'model'
      | 'model_provider'
      | 'model_reasoning_effort'
      | 'personality'
      | 'baseUrl'
      | 'apiKey'
      | 'httpHeaders'
      | 'modelCandidates'
    >
  > = {
    baseUrl,
    apiKey,
    httpHeaders,
  };
  if (explicitProviderName !== null) {
    next.model_provider = explicitProviderName;
  }
  if (explicitModel !== null) {
    next.model = explicitModel;
  }
  if (
    selectedProfile?.model_reasoning_effort !== null &&
    selectedProfile?.model_reasoning_effort !== undefined
  ) {
    next.model_reasoning_effort = selectedProfile.model_reasoning_effort;
  }
  if (
    selectedProfile?.personality !== null &&
    selectedProfile?.personality !== undefined
  ) {
    next.personality = selectedProfile.personality;
  }
  if (
    modelCandidatesFromProfiles.length > 0 &&
    !Array.isArray(rawConfig.modelCandidates)
  ) {
    next.modelCandidates = modelCandidatesFromProfiles;
  }
  return next;
}

/** CLI/测试传入的 model override 允许临时覆盖 profile 派生值，不写回配置文件。 */
function resolveRuntimeModelOverrides(
  overrides: CodingAgentConfigOverrides,
): Partial<
  Pick<
    CodingAgentConfig,
    'model' | 'model_provider' | 'model_reasoning_effort' | 'personality'
  >
> {
  return {
    ...(nonEmptyString(overrides.model) !== null
      ? { model: nonEmptyString(overrides.model)! }
      : {}),
    ...(nonEmptyString(overrides.model_provider) !== null
      ? { model_provider: nonEmptyString(overrides.model_provider)! }
      : {}),
    ...(overrides.model_reasoning_effort !== undefined
      ? { model_reasoning_effort: overrides.model_reasoning_effort }
      : {}),
    ...(overrides.personality !== undefined
      ? { personality: overrides.personality }
      : {}),
  };
}

/** 解析并校验所有 model profile，保留 profile 名作为 map key。 */
function parseModelProfiles(
  value: unknown,
): Record<string, ModelProfileConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, Record<string, unknown>] =>
          typeof entry[1] === 'object' &&
          entry[1] !== null &&
          !Array.isArray(entry[1]),
      )
      .map(([name, profile]) => [name, ModelProfileSchema.parse(profile)]),
  );
}

/** provider 配置允许缺省；缺省时 runtime 使用 adapter 的默认 provider。 */
function parseModelProvider(value: unknown): ModelProviderConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return {
    ...ModelProviderSchema.parse({
      ...(value as Record<string, unknown>),
      http_headers: parseStringRecord(
        (value as Record<string, unknown>).http_headers,
      ),
    }),
  };
}

/** HTTP headers 只接收 string -> string，避免把 TOML 非字符串值传给 fetch/SDK。 */
function parseStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function normalizeApprovalMode(
  value: unknown,
): z.infer<typeof ApprovalModeSchema> {
  if (value === 'never') return 'dont-ask';
  if (value === 'on-request') return 'default';
  if (value === 'always') return 'bypass';
  return ApprovalModeSchema.parse(value);
}

/** 写入 dotted key，支持 `projects."/abs/path".trust_level` 这种 quoted segment。 */
function setDeepValue(
  current: Record<string, unknown>,
  dottedKey: string,
  value: unknown,
): Record<string, unknown> {
  const parts = parseDottedKey(dottedKey);
  if (parts.length === 0) {
    return current;
  }
  const next = structuredClone(current) as Record<string, unknown>;
  let cursor: Record<string, unknown> = next;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]!;
    const existing = cursor[key];
    if (
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      cursor[key] = structuredClone(existing) as Record<string, unknown>;
    } else {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return next;
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
