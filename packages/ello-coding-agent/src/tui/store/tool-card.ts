/**
 * ToolCard 视图模型（纯逻辑）。
 *
 * 验收要求「ToolCard 能折叠/展开并显示 metadata/truncation」。把「从工具结果里抽
 * metadata、拼尾部状态串、判断默认折叠」这段逻辑独立成纯函数，组件只管渲染，并可单测：
 * - 尾部状态串优先级：denied/failed > exitCode > 耗时。
 * - 默认折叠：普通成功工具折叠；带 diff 或失败的工具默认展开（更需要被看到）。
 */
import type { ToolMetadata } from '../../tools/runtime/coding-tool.js';

import {
  readFileChanges,
  summarizeDiff,
  unifiedDiffFromFileChanges,
} from './diff.js';
import type { ToolCallView } from './history-entry.js';

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
  /** 输出被截断时的提示（含 artifact 路径）。 */
  readonly truncationNotice?: string;
  /** edit/write 才有的完整 diff（对话历史里展开渲染）。 */
  readonly diff?: string;
  readonly hasDiff: boolean;
  /** 默认是否折叠。 */
  readonly defaultCollapsed: boolean;
}

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
function summarize(input: unknown, metadata: ToolMetadata | undefined): string {
  const fromMeta =
    text(metadata?.path) ||
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
        return value;
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
  const outputPath = text(metadata?.outputPath);
  if (outputPath !== '') {
    out.push(`artifact ${outputPath}`);
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
): string {
  const kind = metadata?.kind;
  const path = summarize(call.input, metadata);
  if (kind === 'edit' || call.name === 'edit' || call.name === 'write') {
    return `Edited${path !== '' ? ` ${path}` : ''}${diffSummarySuffix(diff)}`;
  }
  if (call.name === 'ls') {
    return `List${path !== '' ? ` ${path}` : ''}`;
  }
  if (kind === 'read' || call.name === 'read') {
    return `Read${path !== '' ? ` ${path}` : ''}`;
  }
  if (call.name === 'grep') {
    return `Search${searchTarget(call.input, metadata)}`;
  }
  if (call.name === 'glob') {
    return `Glob${searchTarget(call.input, metadata)}`;
  }
  if (kind === 'shell' || call.name === 'bash') {
    const command =
      text(metadata?.command) || inputString(call.input, 'command');
    return command !== '' ? `Ran ${command}` : `Ran ${formatName(call.name)}`;
  }
  if (kind === 'network' || call.name === 'web_fetch') {
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
): string {
  const pattern = text(metadata?.pattern) || inputString(input, 'pattern');
  const path = text(metadata?.path) || inputString(input, 'path');
  if (pattern === '') {
    return path !== '' ? ` in ${path}` : '';
  }
  return ` ${pattern}${path !== '' ? ` in ${path}` : ''}`;
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

/** 构建 ToolCard 视图模型。 */
export function buildToolCardModel(call: ToolCallView): ToolCardModel {
  const metadata = readToolMetadata(call.output);
  const fileChanges = readFileChanges(metadata?.fileChanges);
  const diff = unifiedDiffFromFileChanges(fileChanges);
  const hasDiff = diff !== '';
  const truncated = metadata?.truncated === true;
  const outputPath = text(metadata?.outputPath);

  return {
    status: call.status,
    icon: statusIcon(call.status),
    name: formatName(call.name),
    headline: headline(call, metadata, diff),
    summary: summarize(call.input, metadata),
    metaRight: rightStatus(call, metadata),
    metrics: metricList(metadata),
    details: detailList(metadata, diff),
    outputPreview:
      metadata?.kind === 'shell' || call.name === 'bash'
        ? outputPreview(call.output)
        : [],
    ...(truncated
      ? {
          truncationNotice: `output truncated${outputPath !== '' ? `, full log: ${outputPath}` : ''}`,
        }
      : {}),
    ...(hasDiff ? { diff } : {}),
    hasDiff,
    // 默认折叠普通成功工具；diff / 失败默认展开。
    defaultCollapsed: !hasDiff && call.status !== 'fail',
  };
}
