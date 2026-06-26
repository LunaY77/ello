import type { SearchStrategy } from './base.js';

/**
 * 基于关键词匹配的搜索策略。
 */
export class KeywordSearchStrategy implements SearchStrategy {
  getSearchHint(): string {
    return 'Search uses keyword matching. Use specific tool names or action verbs.';
  }

  async buildIndex(_tools: Array<[string, string]>): Promise<void> {
    return;
  }

  async search(
    query: string,
    candidates: Array<[string, string]>,
    maxResults = 10,
  ): Promise<Array<[number, string, string]>> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }

    const results: Array<[number, string, string]> = [];
    for (const [name, desc] of candidates) {
      const text = `${name} ${desc}`.toLowerCase();
      const matches = terms.reduce(
        (count, term) => count + (text.includes(term) ? 1 : 0),
        0,
      );
      const score = matches / terms.length;
      if (score > 0) {
        results.push([score, name, desc]);
      }
    }

    results.sort((a, b) => b[0] - a[0]);
    return results.slice(0, maxResults);
  }
}
