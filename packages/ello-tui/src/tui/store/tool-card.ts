/**
 * ToolCard 视图模型（纯逻辑）。
 *
 * 验收要求「ToolCard 能折叠/展开并显示 metadata/truncation」。把「从工具结果里抽
 * metadata、拼尾部状态串、判断默认折叠」这段逻辑独立成纯函数，组件只管渲染，并可单测：
 * - 尾部状态串优先级：denied/failed > exitCode > 耗时。
 * - 默认折叠：普通成功工具折叠；带 diff 或失败的工具默认展开（更需要被看到）。
 */
import { homedir } from 'node:os';
import path from 'node:path';

import type { FileChange } from '../../api/protocol-types.js';

import {
  readFileChanges,
  summarizeDiff,
  unifiedDiffFromFileChanges,
} from './diff.js';
import type { ToolCallView } from './history-entry.js';

type ToolMetadata = Record<string, unknown>;

export interface ToolCardModel {
  readonly status: ToolCallView['status'];
  readonly icon: string;
  readonly name: string;
  readonly headline: string;
  /** 一行摘要：path / command / pattern / url。 */
  readonly summary: string;
  /** 尾部状态串：`12s` / `exit 1` / `denied`。 */
  readonly metaRight: string;
  /** 次要度量：`12 lines` / `3 matches` / `5 entries`。 */
  readonly metrics: readonly string[];
  readonly details: readonly string[];
  readonly outputPreview: readonly string[];
  /** TUI 只展示短路径，完整路径留给后续展开或复制操作。 */
  readonly artifact?: {
    readonly displayPath: string;
    readonly fullPath: string;
  };
  /** edit/write 才有的完整 diff（对话历史里展开渲染）。 */
  readonly diff?: string;
  readonly fileChanges?: readonly FileChange[];
  readonly hasDiff: boolean;
  /** 默认是否折叠。 */
  readonly defaultCollapsed: boolean;
}

export interface ToolCardDisplayOptions {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly maxPathLength?: number;
}

const DEFAULT_MAX_PATH_LENGTH = 56;

/** 从工具结果对象里取出 {@link ToolMetadata}（CodingToolResult.metadata）。 */
export function readToolMetadata(output: unknown): ToolMetadata | undefined {
  if (typeof output !== 'object' || output === null) {
    return undefined;
  }
  const metadata = (output as { metadata?: unknown }).metadata;
  if (typeof metadata === 'object' && metadata !== null) {
    return metadata as ToolMetadata;
  }
  return undefined;
}

function num(
  metadata: ToolMetadata | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 输入里第一个可作摘要的字段。 */
function summarize(
  input: unknown,
  metadata: ToolMetadata | undefined,
  options: ToolCardDisplayOptions,
): string {
  const metadataPath = displayMetadataPath(metadata, options);
  const fromMeta =
    metadataPath ||
    text(metadata?.command) ||
    text(metadata?.url) ||
    text(metadata?.summary);
  if (fromMeta !== '') {
    return fromMeta;
  }
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ['path', 'command', 'pattern', 'url', 'query']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') {
        return key === 'path' ? formatToolPath(value, options) : value;
      }
    }
  }
  return '';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function statusIcon(status: ToolCallView['status']): string {
  switch (status) {
    case 'running':
      return '⏳';
    case 'ok':
      return '✓';
    case 'fail':
      return '✗';
  }
}

function rightStatus(
  call: ToolCallView,
  metadata: ToolMetadata | undefined,
): string {
  if (call.status === 'fail') {
    const message = call.error?.message ?? '';
    return /deny|denied|not allowed|permission/iu.test(message)
      ? 'denied'
      : 'failed';
  }
  const exitCode = num(metadata, 'exitCode');
  if (exitCode !== undefined && exitCode !== 0) {
    return `exit ${exitCode}`;
  }
  const durationMs = num(metadata, 'durationMs');
  if (durationMs !== undefined) {
    return formatDuration(durationMs);
  }
  return '';
}

function metricList(metadata: ToolMetadata | undefined): readonly string[] {
  const out: string[] = [];
  const lines = num(metadata, 'totalLines');
  if (lines !== undefined) {
    out.push(`${lines} lines`);
  }
  const matches = num(metadata, 'matchCount');
  if (matches !== undefined) {
    out.push(`${matches} matches`);
  }
  const entries = num(metadata, 'entryCount');
  if (entries !== undefined) {
    out.push(`${entries} entries`);
  }
  return out;
}

function detailList(
  metadata: ToolMetadata | undefined,
  diff: string,
): readonly string[] {
  const out: string[] = [];
  const exitCode = num(metadata, 'exitCode');
  if (exitCode !== undefined) {
    out.push(`exit ${exitCode}`);
  }
  const durationMs = num(metadata, 'durationMs');
  if (durationMs !== undefined) {
    out.push(formatDuration(durationMs));
  }
  out.push(...metricList(metadata));
  if (diff !== '') {
    const summary = summarizeDiff(diff);
    out.push(`+${summary.added}/-${summary.removed}`);
  }
  if (metadata?.truncated === true) {
    out.push('truncated');
  }
  return out;
}

function formatName(name: string): string {
  return name
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function headline(
  call: ToolCallView,
  metadata: ToolMetadata | undefined,
  diff: string,
  options: ToolCardDisplayOptions,
): string {
  const kind = metadata?.kind;
  const path = summarize(call.input, metadata, options);
  if (kind === 'edit' || call.name === 'edit' || call.name === 'write') {
    return `Edited${path !== '' ? ` ${path}` : ''}${diffSummarySuffix(diff)}`;
  }
  if (kind === 'read' || call.name === 'read') {
    return `Read${path !== '' ? ` ${path}` : ''}`;
  }
  if (call.name === 'grep') {
    return `Search${searchTarget(call.input, metadata, options)}`;
  }
  if (call.name === 'glob') {
    return `Glob${searchTarget(call.input, metadata, options)}`;
  }
  if (kind === 'shell' || call.name === 'bash') {
    const command =
      text(metadata?.command) || inputString(call.input, 'command');
    return command !== '' ? `Ran ${command}` : `Ran ${formatName(call.name)}`;
  }
  if (kind === 'network') {
    return `Fetched ${text(metadata?.url) || inputString(call.input, 'url')}`;
  }
  if (kind === 'task' || call.name === 'delegate_to_subagent') {
    const agent = inputString(call.input, 'name') || text(metadata?.agentName);
    return `Delegate${agent !== '' ? ` ${agent}` : ''}`;
  }
  return `${formatName(call.name)}${path !== '' ? ` ${path}` : ''}`;
}

function diffSummarySuffix(diff: string): string {
  if (diff === '') {
    return '';
  }
  const summary = summarizeDiff(diff);
  return ` (+${summary.added} -${summary.removed})`;
}

function searchTarget(
  input: unknown,
  metadata: ToolMetadata | undefined,
  options: ToolCardDisplayOptions,
): string {
  const pattern = text(metadata?.pattern) || inputString(input, 'pattern');
  const targetPath = text(metadata?.path) || inputString(input, 'path');
  const displayPath = formatToolPath(targetPath, options);
  if (pattern === '') {
    return displayPath !== '' ? ` in ${displayPath}` : '';
  }
  return ` ${pattern}${displayPath !== '' ? ` in ${displayPath}` : ''}`;
}

function inputString(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) {
    return '';
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function outputPreview(output: unknown): readonly string[] {
  const textOutput = readOutputText(output);
  if (textOutput === '') {
    return [];
  }
  return textOutput
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .slice(0, 8);
}

function readOutputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (typeof output !== 'object' || output === null) {
    return '';
  }
  const value = (output as { readonly output?: unknown }).output;
  return typeof value === 'string' ? value : '';
}

/**
 * 工具真实参数保留绝对路径，只有 TUI 视图模型会缩短路径：
 * `~/.ello` 下的文件使用波浪号，当前工作目录下的文件使用相对路径。
 */
export function formatToolPath(
  value: string,
  options: ToolCardDisplayOptions,
): string {
  if (value === '') {
    return value;
  }
  let displayPath = value;
  if (path.isAbsolute(value)) {
    const target = path.resolve(value);
    const home = path.resolve(options.homeDir ?? homedir());
    const elloHome = path.join(home, '.ello');
    if (isWithin(elloHome, target)) {
      const relative = path.relative(home, target);
      displayPath = relative === '' ? '~' : `~/${relative}`;
    } else {
      const cwd = path.resolve(options.cwd);
      if (isWithin(cwd, target)) {
        displayPath = path.relative(cwd, target) || '.';
      } else if (isWithin(home, target)) {
        const relative = path.relative(home, target);
        displayPath = relative === '' ? '~' : `~/${relative}`;
      }
    }
  }
  return compactToolPath(
    displayPath,
    options.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH,
  );
}

/** 从内部落盘路径提取稳定、可辨认的短 artifact 标识。 */
export function formatArtifactPath(outputPath: string): string {
  const fileName = path.basename(outputPath);
  const artifactId = path.basename(path.dirname(outputPath));
  const compactId =
    artifactId.length > 16
      ? `${artifactId.slice(0, 8)}…${artifactId.slice(-4)}`
      : artifactId;
  return `${compactId}/${fileName}`;
}

/** 构建 ToolCard 视图模型。 */
export function buildToolCardModel(
  call: ToolCallView,
  options: ToolCardDisplayOptions,
): ToolCardModel {
  const metadata = readToolMetadata(call.output);
  const sourceFileChanges = readFileChanges(metadata?.fileChanges);
  const fileChanges = sourceFileChanges.map((change) => ({
    ...change,
    path: formatToolPath(change.path, options),
    ...(change.kind === 'rename' && change.oldPath !== undefined
      ? { oldPath: formatToolPath(change.oldPath, options) }
      : {}),
  }));
  const diff = unifiedDiffFromFileChanges(sourceFileChanges);
  const hasDiff = diff !== '';
  const outputPath = text(metadata?.outputPath);

  return {
    status: call.status,
    icon: statusIcon(call.status),
    name: formatName(call.name),
    headline: headline(call, metadata, diff, options),
    summary: summarize(call.input, metadata, options),
    metaRight: rightStatus(call, metadata),
    metrics: metricList(metadata),
    details: detailList(metadata, diff),
    outputPreview:
      metadata?.kind === 'shell' || call.name === 'bash'
        ? outputPreview(call.output)
        : [],
    ...(outputPath !== ''
      ? {
          artifact: {
            displayPath: formatArtifactPath(outputPath),
            fullPath: outputPath,
          },
        }
      : {}),
    ...(hasDiff ? { diff } : {}),
    ...(fileChanges.length > 0 ? { fileChanges } : {}),
    hasDiff,
    // 默认折叠普通成功工具；diff / 失败默认展开。
    defaultCollapsed: !hasDiff && call.status !== 'fail',
  };
}

function compactToolPath(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const prefix = value.startsWith('~/')
    ? '~/'
    : value.startsWith('/')
      ? '/'
      : '';
  const body = prefix === '' ? value : value.slice(prefix.length);
  const segments = body.split('/').filter((segment) => segment !== '');
  if (segments.length < 4) {
    return value;
  }

  const suffix = segments.slice(-2);
  const leading = [segments[0]!];
  for (const segment of segments.slice(1, -2)) {
    const candidate = joinCompactedPath(prefix, [...leading, segment], suffix);
    if (candidate.length > maxLength) {
      break;
    }
    leading.push(segment);
  }
  return joinCompactedPath(prefix, leading, suffix);
}

function joinCompactedPath(
  prefix: string,
  leading: readonly string[],
  suffix: readonly string[],
): string {
  return `${prefix}${[...leading, '…', ...suffix].join('/')}`;
}

function displayMetadataPath(
  metadata: ToolMetadata | undefined,
  options: ToolCardDisplayOptions,
): string {
  const metadataPath = text(metadata?.path);
  const metadataPaths = Array.isArray(metadata?.paths)
    ? metadata.paths.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  if (metadataPaths.length > 0 && metadataPath === metadataPaths.join(', ')) {
    return metadataPaths
      .map((value) => formatToolPath(value, options))
      .join(', ');
  }
  return formatToolPath(metadataPath, options);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}
