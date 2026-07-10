/**
 * 审批请求 → 分类视图模型。
 *
 * 验收要求「approval dialog 对 edit/bash/read/network/task 显示不同内容」。把「怎么读
 * metadata、归到哪一类、抽哪些字段」这段纯逻辑独立出来，使 PermissionDialog 只负责把
 * 字段画出来，且这段分类逻辑可单测。审批阶段**只给 diff 摘要**（+N/-M），完整 unified
 * diff 留给对话历史展示——这是文档对 diff 展示的明确分工。
 */
import { readFileChanges, summarizeDiff, type DiffSummary } from './diff.js';

export type PermissionViewKind =
  | 'edit'
  | 'shell'
  | 'read'
  | 'search'
  | 'network'
  | 'task'
  | 'external_directory'
  | 'generic';

export interface PermissionField {
  readonly label: string;
  readonly value: string;
}

export interface PermissionViewModel {
  readonly kind: PermissionViewKind;
  readonly title: string;
  readonly toolName: string;
  readonly fields: readonly PermissionField[];
  /** edit：仅摘要，不含完整 diff。 */
  readonly diffSummary?: DiffSummary;
  /** shell：高风险命令的提示标签。 */
  readonly risk?: string;
}

/** 与审批浮层兼容的最小入参。 */
export interface PermissionRequestLike {
  readonly toolName: string;
  readonly input: unknown;
  readonly metadata?: Record<string, unknown>;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'edit',
  'shell',
  'read',
  'search',
  'network',
  'task',
  'external_directory',
  'workspace',
  'generic',
]);

/** 解析分类：优先 metadata.kind，否则按工具名推断。 */
function resolveKind(request: PermissionRequestLike): PermissionViewKind {
  const metadata = permissionMetadata(request);
  const raw = metadata?.['kind'];
  if (typeof raw === 'string' && KNOWN_KINDS.has(raw)) {
    // ToolMetadataKind 用 `workspace` 表示「写入工作区外目录」，审批视图沿用文档
    // 里的 `external_directory` 命名以突出风险。
    return raw === 'workspace'
      ? 'external_directory'
      : (raw as PermissionViewKind);
  }
  return inferKindFromName(request.toolName);
}

function inferKindFromName(name: string): PermissionViewKind {
  if (name === 'edit' || name === 'write' || name === 'apply_patch') {
    return 'edit';
  }
  if (name === 'bash' || name === 'shell') {
    return 'shell';
  }
  if (name === 'read') {
    return 'read';
  }
  if (name === 'grep' || name === 'glob' || name === 'search') {
    return 'search';
  }
  if (name === 'fetch' || name === 'web' || name === 'web_fetch') {
    return 'network';
  }
  if (name === 'delegate' || name.startsWith('task')) {
    return 'task';
  }
  return 'generic';
}

const TITLES: Record<PermissionViewKind, string> = {
  edit: 'Edit file',
  shell: 'Run command',
  read: 'Read file',
  search: 'Search',
  network: 'Network request',
  task: 'Run subagent task',
  external_directory: 'Write outside workspace',
  generic: 'Tool call',
};

function metaString(
  request: PermissionRequestLike,
  key: string,
): string | undefined {
  const value = permissionMetadata(request)?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function inputString(
  request: PermissionRequestLike,
  key: string,
): string | undefined {
  if (typeof request.input !== 'object' || request.input === null) {
    return undefined;
  }
  const value = (request.input as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 取 metadata/input 中的第一个非空字符串。 */
function pick(request: PermissionRequestLike, key: string): string | undefined {
  return metaString(request, key) ?? inputString(request, key);
}

function metaPaths(request: PermissionRequestLike): readonly string[] {
  const value = permissionMetadata(request)?.['paths'];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/** 高风险 shell 命令的粗粒度检测（仅提示，不阻断；真正放行权在用户）。 */
const DANGER_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?/u,
  /\bsudo\b/u,
  /\bmkfs\b/u,
  /\b(curl|wget)\b[^\n]*\|\s*(sh|bash)\b/u,
  /\bgit\s+push\s+--force\b/u,
  /\bchmod\s+-R\b/u,
  /:\(\)\s*\{/u,
];

function detectRisk(command: string): string | undefined {
  return DANGER_PATTERNS.some((pattern) => pattern.test(command))
    ? 'destructive command — review carefully'
    : undefined;
}

/** 项目级 allow 规则写入的目标文件，二次确认时需向用户明示。 */
export const PROJECT_RULES_FILE = '.ello/permissions.yaml';

/** 构建分类视图模型。 */
export function buildPermissionView(
  request: PermissionRequestLike,
): PermissionViewModel {
  const kind = resolveKind(request);
  const fields: PermissionField[] = [];
  const base = {
    kind,
    title: TITLES[kind],
    toolName: request.toolName,
  };

  if (kind === 'edit') {
    const path = pick(request, 'path');
    if (path !== undefined) {
      fields.push({ label: 'path', value: path });
    }
    const fileChanges = readFileChanges(
      permissionMetadata(request)?.['fileChanges'],
    );
    return {
      ...base,
      fields,
      ...(fileChanges.length > 0
        ? { diffSummary: summarizeDiff(fileChanges) }
        : {}),
    };
  }

  if (kind === 'shell') {
    const command = pick(request, 'command') ?? '';
    fields.push({ label: '$', value: command });
    const cwd = pick(request, 'cwd');
    if (cwd !== undefined) {
      fields.push({ label: 'cwd', value: cwd });
    }
    const risk = detectRisk(command);
    return { ...base, fields, ...(risk !== undefined ? { risk } : {}) };
  }

  if (kind === 'read') {
    const path = pick(request, 'path');
    if (path !== undefined) {
      fields.push({ label: 'path', value: path });
    }
    return { ...base, fields };
  }

  if (kind === 'search') {
    const pattern = pick(request, 'pattern');
    if (pattern !== undefined) {
      fields.push({ label: 'pattern', value: pattern });
    }
    const path = pick(request, 'path');
    if (path !== undefined) {
      fields.push({ label: 'in', value: path });
    }
    return { ...base, fields };
  }

  if (kind === 'network') {
    const url = pick(request, 'url');
    if (url !== undefined) {
      fields.push({ label: 'url', value: url });
    }
    const domain = pick(request, 'domain');
    if (domain !== undefined) {
      fields.push({ label: 'domain', value: domain });
    }
    return { ...base, fields };
  }

  if (kind === 'task') {
    const agent =
      pick(request, 'agentName') ??
      pick(request, 'agent') ??
      pick(request, 'subagent_type');
    if (agent !== undefined) {
      fields.push({ label: 'agent', value: agent });
    }
    const description = pick(request, 'description');
    if (description !== undefined) {
      fields.push({ label: 'task', value: description });
    }
    return { ...base, fields };
  }

  if (kind === 'external_directory') {
    for (const path of metaPaths(request)) {
      fields.push({ label: 'path', value: path });
    }
    const path = pick(request, 'path');
    if (path !== undefined && !fields.some((field) => field.value === path)) {
      fields.push({ label: 'path', value: path });
    }
    return { ...base, fields };
  }

  // generic：尽量给出一行可读摘要。
  const summary = metaString(request, 'summary');
  if (summary !== undefined) {
    fields.push({ label: 'summary', value: summary });
  }
  return { ...base, fields };
}

function permissionMetadata(
  request: PermissionRequestLike,
): Record<string, unknown> | undefined {
  const nested = request.metadata?.['request'];
  if (typeof nested === 'object' && nested !== null) {
    return nested as Record<string, unknown>;
  }
  return request.metadata;
}
