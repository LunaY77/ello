import type { LoadedConfigSource } from './loader.js';

export type ConfigSettingValueType =
  | 'boolean'
  | 'enum'
  | 'integer'
  | 'number'
  | 'string'
  | 'stringList'
  | 'json'
  | 'secret';

export type ConfigSettingEffect =
  | 'immediate'
  | 'nextTurn'
  | 'newThread'
  | 'restart';

export interface ConfigSettingDescriptor {
  readonly id: string;
  readonly path: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly type: ConfigSettingValueType;
  readonly value?: unknown;
  readonly source: LoadedConfigSource['name'];
  readonly writableScopes: readonly ('global' | 'project')[];
  readonly effect: ConfigSettingEffect;
  readonly options?: readonly string[];
  readonly sensitive: boolean;
}

interface SettingMetadata {
  readonly type?: ConfigSettingValueType;
  readonly options?: readonly string[];
  readonly effect?: ConfigSettingEffect;
  readonly writableScopes?: readonly ('global' | 'project')[];
  readonly description?: string;
  readonly sensitive?: boolean;
}

const EXCLUDED_ROOTS = new Set([
  'active_profile',
  'cwd',
  'models',
  'profile',
  'session_id',
]);

const METADATA: Readonly<Record<string, SettingMetadata>> = {
  default_agent: {
    effect: 'newThread',
    writableScopes: ['global'],
    description: 'Default primary agent for newly created threads.',
  },
  initial_mode: {
    type: 'enum',
    options: ['ask-before-changes', 'accept-edits', 'plan', 'bypass'],
    effect: 'newThread',
    description: 'Initial safety mode for newly created threads.',
  },
  bypass_enabled: {
    effect: 'newThread',
    description: 'Allow new threads to enter bypass mode.',
  },
  session_dir: { effect: 'restart' },
  mcp_config_path: { type: 'string', effect: 'restart' },
  tui: { effect: 'restart' },
  json: { effect: 'restart' },
  'workspace.mount': { effect: 'restart' },
  'provider.*.kind': {
    type: 'enum',
    options: ['openai', 'anthropic', 'openai-compatible'],
  },
  'provider.*.api_key': { type: 'secret', sensitive: true },
  'provider.*.api_key_env': { type: 'secret', sensitive: true },
  'provider.*.api_key_file': { type: 'secret', sensitive: true },
  'provider.*.headers': { type: 'json', sensitive: true },
  'provider.*.options': { type: 'json', sensitive: true },
  'agent.*.mode': {
    type: 'enum',
    options: ['primary', 'subagent', 'internal', 'all'],
  },
  'agent.*.role': {
    type: 'enum',
    options: ['primary', 'small', 'compact', 'title', 'review'],
  },
  'projects.*.trust_level': {
    type: 'enum',
    options: ['trusted', 'untrusted'],
    writableScopes: ['global'],
  },
  'observability.langfuse.content': {
    type: 'enum',
    options: ['metadata', 'full'],
    effect: 'restart',
  },
  observability: {
    type: 'json',
    effect: 'restart',
    description: 'Observability configuration, including Langfuse tracing.',
  },
};

export function describeConfigSettings(
  config: unknown,
  sources: readonly LoadedConfigSource[],
): readonly ConfigSettingDescriptor[] {
  const root = isRecord(config) ? config : {};
  const leaves: Array<{
    readonly path: readonly string[];
    readonly value: unknown;
  }> = [];
  for (const [key, value] of Object.entries(root)) {
    if (EXCLUDED_ROOTS.has(key)) continue;
    flattenValue([key], value, leaves);
  }
  if (!Object.hasOwn(root, 'observability')) {
    leaves.push({ path: ['observability'], value: undefined });
  }
  appendSensitiveProviderSettings(root, leaves);
  return leaves
    .map(({ path, value }) => descriptorFor(path, value, sources))
    .sort((left, right) =>
      left.group === right.group
        ? left.id.localeCompare(right.id)
        : left.group.localeCompare(right.group),
    );
}

function flattenValue(
  path: readonly string[],
  value: unknown,
  leaves: Array<{ readonly path: readonly string[]; readonly value: unknown }>,
): void {
  if (isSensitiveProviderPath(path)) {
    leaves.push({ path: path.slice(0, 3), value: undefined });
    return;
  }
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const [key, nested] of Object.entries(value)) {
      flattenValue([...path, key], nested, leaves);
    }
    return;
  }
  leaves.push({ path, value });
}

function appendSensitiveProviderSettings(
  root: Record<string, unknown>,
  leaves: Array<{ readonly path: readonly string[]; readonly value: unknown }>,
): void {
  const providers = root.provider;
  if (!isRecord(providers)) return;
  const ids = new Set(leaves.map((leaf) => settingId(leaf.path)));
  for (const provider of Object.keys(providers)) {
    for (const field of [
      'api_key',
      'api_key_env',
      'api_key_file',
      'headers',
      'options',
    ] as const) {
      const path = ['provider', provider, field];
      if (ids.has(settingId(path))) continue;
      leaves.push({ path, value: undefined });
    }
  }
}

function descriptorFor(
  path: readonly string[],
  value: unknown,
  sources: readonly LoadedConfigSource[],
): ConfigSettingDescriptor {
  const id = settingId(path);
  const metadata = metadataFor(path);
  const sensitive =
    metadata.sensitive === true || isSensitiveProviderPath(path);
  return {
    id,
    path,
    label: humanize(path.at(-1) ?? id),
    description: metadata.description ?? `Configure ${id}.`,
    group: groupFor(path[0] ?? ''),
    type: metadata.type ?? inferType(value),
    ...(sensitive || value === undefined ? {} : { value }),
    source: sourceFor(path, sources),
    writableScopes: metadata.writableScopes ?? writableScopesFor(path[0] ?? ''),
    effect: metadata.effect ?? effectFor(path[0] ?? ''),
    ...(metadata.options === undefined ? {} : { options: metadata.options }),
    sensitive,
  };
}

function metadataFor(path: readonly string[]): SettingMetadata {
  const exact = METADATA[settingId(path)];
  if (exact !== undefined) return exact;
  for (const [pattern, metadata] of Object.entries(METADATA)) {
    const parts = pattern.split('.');
    if (
      parts.length === path.length &&
      parts.every((part, index) => part === '*' || part === path[index])
    ) {
      return metadata;
    }
  }
  return {};
}

function sourceFor(
  path: readonly string[],
  sources: readonly LoadedConfigSource[],
): LoadedConfigSource['name'] {
  for (const name of ['override', 'project', 'global', 'defaults'] as const) {
    const source = sources.find((candidate) => candidate.name === name);
    if (source !== undefined && hasPath(source.data, path)) return name;
  }
  return 'defaults';
}

function hasPath(value: unknown, path: readonly string[]): boolean {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function inferType(value: unknown): ConfigSettingValueType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return 'stringList';
  if (typeof value === 'string' || value === null || value === undefined)
    return 'string';
  return 'json';
}

function effectFor(root: string): ConfigSettingEffect {
  return root === 'observability' ? 'restart' : 'nextTurn';
}

function writableScopesFor(root: string): readonly ('global' | 'project')[] {
  return root === 'projects' ? ['global'] : ['global', 'project'];
}

function groupFor(root: string): string {
  if (root === 'provider') return 'Providers';
  if (root === 'agent') return 'Agents';
  if (root === 'tools' || root === 'tool_output') return 'Tools';
  if (root === 'context') return 'Context';
  if (root === 'goal') return 'Goal';
  if (root === 'observability') return 'Observability';
  if (root === 'workspace') return 'Workspace';
  if (
    root === 'allowed_paths' ||
    root === 'bypass_enabled' ||
    root === 'permission_rules' ||
    root === 'projects'
  ) {
    return 'Security';
  }
  return 'General';
}

function isSensitiveProviderPath(path: readonly string[]): boolean {
  return (
    path[0] === 'provider' &&
    ['api_key', 'api_key_env', 'api_key_file', 'headers', 'options'].includes(
      path[2] ?? '',
    )
  );
}

function settingId(path: readonly string[]): string {
  return path.map((segment) => encodeURIComponent(segment)).join('.');
}

function humanize(value: string): string {
  return value
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
