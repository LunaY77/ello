/**
 * 本文件负责 agent feature 的“source-registry”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { SystemSection } from '../engine/index.js';

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
   * stale=true 表示刷新失败后使用了过期缓存，仍可作为参考，但不能当作当前事实。
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

/**
 * 执行 产品 Agent `source-registry` 模块 定义的 `ContextSourceLoader` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - Promise 在 产品 Agent `source-registry` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export type ContextSourceLoader = () => Promise<ContextSourceLoadResult>;

export interface ContextSourceLoadResult {
  readonly sources: readonly ContextSource[];
  readonly diagnostics?: readonly ContextDiagnostic[];
}

export interface ContextSectionOptions {
  readonly loaders: readonly ContextSourceLoader[];
  /**
   * 处理 产品 Agent `source-registry` 模块 的 `onEvent` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   *
   * Returns:
   * - 产品 Agent `source-registry` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  readonly onEvent?: (event: ContextEvent) => void;
}

/**
 * 把多组 source loader 合并为单个 SystemSection。
 *
 * Args:
 * - `options`: 仅作用于 `createContextBundleSection` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `createContextBundleSection` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent `source-registry` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createContextBundleSection(
  options: ContextSectionOptions,
): SystemSection {
  return async () => {
    const bundle = await loadContextBundle(options.loaders, options.onEvent);
    return bundle.system || null;
  };
}

/**
 * 读取、排序、渲染完整 context bundle。
 *
 * Args:
 * - `loaders`: `loadContextBundle` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `onEvent`: 生命周期内调用的回调；回调失败属于当前操作失败，不会被静默吞掉。
 *
 * Returns:
 * - Promise 在 产品 Agent `source-registry` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 产品 Agent `source-registry` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function loadContextBundle(
  loaders: readonly ContextSourceLoader[],
  onEvent?: (event: ContextEvent) => void,
): Promise<ContextBundle> {
  const sources: ContextSource[] = [];
  const diagnostics: ContextDiagnostic[] = [];
  for (const loader of loaders) {
    const result = await loader();
    sources.push(...result.sources);
    diagnostics.push(...(result.diagnostics ?? []));
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

/**
 * 粗略 token 估算：与 compactor 保持同一 chars/4 口径。
 *
 * Args:
 * - `text`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - 返回 `estimateTextTokens` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 执行 产品 Agent `source-registry` 模块 定义的 `renderContextSources` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `sources`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `renderContextSources` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function renderContextSources(
  sources: readonly ContextSource[],
): string {
  return sources.map(renderContextSource).filter(Boolean).join('\n\n');
}

/**
 * 执行 产品 Agent `source-registry` 模块 定义的 `renderContextSource` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `source`: `renderContextSource` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `renderContextSource` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
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
