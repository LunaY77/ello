import type { SearchStrategy } from './base.js';
import { KeywordSearchStrategy } from './keyword.js';

/**
 * BM25 搜索策略。
 *
 * TS 版在不引入额外依赖时先回退到关键词策略，保持接口和结果形态。
 */
export class BM25SearchStrategy implements SearchStrategy {
  private readonly fallback = new KeywordSearchStrategy();

  getSearchHint(): string {
    return this.fallback.getSearchHint();
  }

  async buildIndex(tools: Array<[string, string]>): Promise<void> {
    return this.fallback.buildIndex(tools);
  }

  async search(
    query: string,
    candidates: Array<[string, string]>,
    maxResults = 10,
  ): Promise<Array<[number, string, string]>> {
    return this.fallback.search(query, candidates, maxResults);
  }
}
