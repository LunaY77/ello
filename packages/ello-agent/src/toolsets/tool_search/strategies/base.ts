/** 工具搜索策略协议。 */
export interface SearchStrategy {
  /** 返回搜索使用提示。 */
  getSearchHint(): string;

  /** 构建搜索索引。 */
  buildIndex(tools: Array<[string, string]>): Promise<void>;

  /** 搜索工具。 */
  search(
    query: string,
    candidates: Array<[string, string]>,
    maxResults?: number,
  ): Promise<Array<[number, string, string]>>;
}
