/**
 * 本文件负责 thread feature 的“export”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { ThreadItem, ThreadSnapshot } from '../../protocol/v1/index.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcRouteFragment } from '../../server/rpc/route.js';
import type { ArtifactStore } from '../artifact/index.js';

import type { ThreadStore } from './store.js';

import type { ThreadFeature } from './index.js';

const INLINE_ARTIFACT_BYTES = 256 * 1024;

/** Thread 导出超过内联上限时转为 artifact，避免 RPC 响应无界增长。 */
interface ExportContext {
  readonly artifacts: ArtifactStore;
  readonly store: ThreadStore;
  readonly threads: ThreadFeature;
}

const exportHandlers = {
  'thread/export': async (context, params) => {
    const snapshot = await context.threads.read({
      threadId: params.threadId,
      includeTurns: true,
      includeItems: true,
    });
    const mediaType =
      params.format === 'jsonl'
        ? 'application/x-ndjson'
        : params.format === 'html'
          ? 'text/html'
          : 'text/markdown';
    const content =
      params.format === 'jsonl'
        ? `${(await context.store.read(params.threadId))
            .map((record) => JSON.stringify(record))
            .join('\n')}\n`
        : params.format === 'html'
          ? renderThreadHtml(snapshot)
          : renderThreadMarkdown(snapshot);
    const byteCount = Buffer.byteLength(content);
    if (byteCount <= INLINE_ARTIFACT_BYTES) {
      return { kind: 'inline', content, mediaType };
    }
    const artifact = await context.artifacts.put({
      kind: 'thread-export',
      content,
      contentType: mediaType,
      owner: {
        kind: 'session-export',
        id: params.threadId,
        relation: params.format,
      },
    });
    return {
      kind: 'artifact',
      artifactId: artifact.id,
      byteCount: artifact.byteSize,
      mediaType,
    };
  },
} satisfies FeatureHandlerMap<ExportContext, 'thread/export'>;

/**
 * 构造 Thread `export` 模块 中的 `createExportRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `context`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 *
 * Returns:
 * - 返回 `createExportRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Thread `export` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createExportRoutes(
  context: ExportContext,
): RpcRouteFragment<'thread/export'> {
  return {
    'thread/export': bindFeatureRoute(
      exportHandlers,
      () => context,
      'thread/export',
    ),
  };
}

function renderThreadMarkdown(snapshot: ThreadSnapshot): string {
  const lines = [
    `# ${snapshot.thread.name || snapshot.thread.id}`,
    '',
    `- Thread: ${snapshot.thread.id}`,
    `- CWD: ${snapshot.thread.cwd}`,
    '',
  ];
  for (const turn of snapshot.turns) {
    lines.push(`## Turn ${turn.id}`, '');
    for (const item of turn.items) lines.push(renderItem(item), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderThreadHtml(snapshot: ThreadSnapshot): string {
  const title = escapeHtml(snapshot.thread.name || snapshot.thread.id);
  const content = escapeHtml(renderThreadMarkdown(snapshot));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><pre>${content}</pre></body></html>`;
}

function renderItem(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage':
    case 'agentMessage':
    case 'plan':
      return `### ${item.type}\n\n${item.text}`;
    case 'commandExecution':
      return `### command\n\n\`${item.command}\`\n\n${item.outputPreview ?? ''}`;
    case 'fileChange':
      return `### files\n\n${item.changes.map((change) => change.path).join('\n')}`;
    case 'toolCall':
      return `### ${item.toolName}\n\n${item.outputPreview ?? item.headline}`;
    case 'reasoning':
      return `### reasoning\n\n${item.summary}`;
    case 'subagent':
      return `### ${item.agentName}\n\n${item.output ?? item.description}`;
    case 'contextCompaction':
      return `### compaction\n\n${item.summary}`;
    case 'notice':
    case 'error':
      return `### ${item.type}\n\n${item.message}`;
    default:
      item satisfies never;
      throw new Error(`Unhandled thread item: ${String(item)}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
