/**
 * 本文件负责 memory feature 的“index-loader”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import {
  estimateTextTokens,
  type ContextSourceLoadResult,
} from '../../agent/index.js';

import type { MemoryScope } from './paths.js';
import { memoryRoot } from './paths.js';
import { MEMORY_INDEX_FILE, parseMemoryIndex } from './schema.js';
import type { MemoryStore } from './store.js';

export class MemoryIndexLoader {
  private cached: Promise<ContextSourceLoadResult> | undefined;

  /**
   * 创建 `MemoryIndexLoader`，由该实例独占 Memory `index-loader` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `repository`: 调用方拥有的持久化依赖；函数使用其事务语义，但不接管关闭责任。
   */
  constructor(private readonly repository: MemoryStore) {}

  /**
   * 读取 Memory `index-loader` 模块 的 `load` 视图，不转移底层状态所有权。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在 Memory `index-loader` 模块 的异步读取或状态变更完成后兑现为声明结果。
   *
   * Throws:
   * - 当 Memory `index-loader` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
   */
  load(): Promise<ContextSourceLoadResult> {
    if (this.cached === undefined) {
      this.cached = this.loadCurrent();
    }
    return this.cached;
  }

  /**
   * 执行 Memory `index-loader` 模块 定义的 `invalidate` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Memory `index-loader` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  invalidate(): void {
    this.cached = undefined;
  }

  private async loadCurrent(): Promise<ContextSourceLoadResult> {
    const sources = await Promise.all(
      scopes().map(async (scope) => {
        const index = await this.repository.read(scope, MEMORY_INDEX_FILE);
        parseMemoryIndex(index.content);
        const root = memoryRoot(this.repository.roots, scope);
        const content = [
          `Memory root: ${root}`,
          '<memory-index>',
          index.content.trim(),
          '</memory-index>',
        ].join('\n');
        return {
          id: `memory:${scope}`,
          type: 'memory' as const,
          title: `${scope} memory index`,
          priority: scope === 'private' ? 180 : 181,
          content,
          origin: root,
          tokensEstimate: estimateTextTokens(content),
        };
      }),
    );
    return { sources };
  }
}

function scopes(): readonly MemoryScope[] {
  return ['private', 'team'];
}
