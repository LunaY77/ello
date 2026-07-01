import type { SystemSection } from '@ello/agent';

/** context source 的类型，用于 TUI 分组、预算裁剪和诊断展示。 */
export type ContextSourceType =
  | 'instruction'
  | 'memory'
  | 'skill'
  | 'reference'
  | 'mcp'
  | 'environment';

/** 单个可观测上下文来源。 */
export interface ContextSource {
  readonly id: string;
  readonly type: ContextSourceType;
  readonly title: string;
  /**
   * 数字越小越先注入；后续预算裁剪也会优先保留高优先级 source。
   * 不要把 sources 当作随机数组处理，必须显式按 priority 排序。
   */
  readonly priority: number;
  readonly content: string;
  readonly origin?: string;
  readonly tokensEstimate?: number;
  /**
   * stale=true 表示内容来自缓存或上一次观测，仍可作为参考，但不能当作当前事实。
   * TUI 和诊断层需要显式展示 stale 状态，避免用户误以为它是实时读取结果。
   */
  readonly stale?: boolean;
}

/** context pipeline 的诊断信息。 */
export interface ContextDiagnostic {
  readonly level: 'info' | 'warn' | 'error';
  readonly origin: string;
  readonly message: string;
}

/** 当前 run 的最终 context bundle。 */
export interface ContextBundle {
  readonly sources: readonly ContextSource[];
  readonly system: string;
  readonly diagnostics: readonly ContextDiagnostic[];
}

export type ContextEvent =
  | { readonly type: 'context.source.loaded'; readonly source: ContextSource }
  | {
      readonly type: 'context.source.failed';
      readonly origin: string;
      readonly error: string;
    }
  | {
      readonly type: 'context.compaction.started';
      readonly reason: 'auto' | 'manual' | 'overflow';
    }
  | {
      readonly type: 'context.compaction.completed';
      readonly compactionId: string;
      readonly firstKeptEntryId: string;
      readonly tokensBefore: number;
      readonly summarizedMessages: number;
      readonly keptMessages: number;
    };

export type ContextSourceLoader = () => Promise<ContextSourceLoadResult>;

export interface ContextSourceLoadResult {
  readonly sources: readonly ContextSource[];
  readonly diagnostics?: readonly ContextDiagnostic[];
}

export interface ContextSectionOptions {
  readonly loaders: readonly ContextSourceLoader[];
  readonly onEvent?: (event: ContextEvent) => void;
}

/** 把多组 source loader 合并为单个 SystemSection。 */
export function createContextBundleSection(
  options: ContextSectionOptions,
): SystemSection {
  return async () => {
    const bundle = await loadContextBundle(options.loaders, options.onEvent);
    return bundle.system || null;
  };
}

/** 读取、排序、渲染完整 context bundle。 */
export async function loadContextBundle(
  loaders: readonly ContextSourceLoader[],
  onEvent?: (event: ContextEvent) => void,
): Promise<ContextBundle> {
  const sources: ContextSource[] = [];
  const diagnostics: ContextDiagnostic[] = [];
  for (const loader of loaders) {
    try {
      const result = await loader();
      sources.push(...result.sources);
      diagnostics.push(...(result.diagnostics ?? []));
    } catch (error) {
      diagnostics.push({
        level: 'error',
        origin: 'context-loader',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const deduped = dedupeSources(sources).sort(compareSource);
  for (const source of deduped) {
    onEvent?.({ type: 'context.source.loaded', source });
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.level !== 'info') {
      onEvent?.({
        type: 'context.source.failed',
        origin: diagnostic.origin,
        error: diagnostic.message,
      });
    }
  }

  return {
    sources: deduped,
    system: renderContextSources(deduped),
    diagnostics,
  };
}

/** 粗略 token 估算：与 compactor 保持同一 chars/4 口径。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function renderContextSources(
  sources: readonly ContextSource[],
): string {
  return sources.map(renderContextSource).filter(Boolean).join('\n\n');
}

export function renderContextSource(source: ContextSource): string {
  const tag = tagForSourceType(source.type);
  const attrs = [
    `id="${escapeAttribute(source.id)}"`,
    `title="${escapeAttribute(source.title)}"`,
    source.origin !== undefined
      ? `origin="${escapeAttribute(source.origin)}"`
      : null,
    source.stale === true ? 'stale="true"' : null,
  ].filter(Boolean);
  return `<${tag} ${attrs.join(' ')}>\n${source.content.trim()}\n</${tag}>`;
}

function compareSource(left: ContextSource, right: ContextSource): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  return left.id.localeCompare(right.id);
}

function dedupeSources(sources: readonly ContextSource[]): ContextSource[] {
  const seen = new Map<string, ContextSource>();
  for (const source of sources) {
    const current = seen.get(source.id);
    if (current === undefined || source.priority < current.priority) {
      seen.set(source.id, source);
    }
  }
  return [...seen.values()];
}

function tagForSourceType(type: ContextSourceType): string {
  switch (type) {
    case 'environment':
      return 'environment-context';
    case 'instruction':
      return 'instruction-context';
    case 'memory':
      return 'memory-context';
    case 'skill':
      return 'skill-context';
    case 'reference':
      return 'reference-context';
    case 'mcp':
      return 'mcp-context';
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
