/**
 * 通用加权文本索引。
 *
 * 构建时对每个字段执行 Unicode NFKC 归一化和字母/数字分词，建立倒排表及 BM25
 * 所需统计量。查询按 exact、prefix、fuzzy 的递减倍率评分，再按查询 token 覆盖率
 * 衰减；最终使用 score 降序、文档名升序保证结果稳定。工具和 Skill 只负责提供
 * 字段及权重，不得复制这里的匹配参数。
 */
export interface WeightedSearchField {
  readonly name: string;
  readonly weight: number;
  readonly text: string;
}

export interface WeightedSearchResult<T> {
  readonly value: T;
  readonly matchedBy: readonly string[];
  readonly score: number;
}

interface IndexedField {
  readonly name: string;
  readonly weight: number;
  readonly tokens: readonly string[];
}

interface IndexedDocument<T> {
  readonly value: T;
  readonly name: string;
  readonly fields: readonly IndexedField[];
}

type TermMatch = {
  term: string;
  kind: 'exact' | 'prefix' | 'fuzzy';
  multiplier: number;
};

export class WeightedSearchIndex<T> {
  private readonly documents: readonly IndexedDocument<T>[];
  private readonly inverted = new Map<string, Set<number>>();
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageFieldLength = new Map<string, number>();

  constructor(
    values: readonly T[],
    fields: (value: T) => readonly WeightedSearchField[],
    name: (value: T) => string,
  ) {
    const documents = values.map((value) => ({
      value,
      name: name(value),
      fields: fields(value).map((field) => ({
        name: field.name,
        weight: field.weight,
        tokens: tokenize(field.text),
      })),
    }));
    if (documents.length === 0) {
      this.documents = [];
      return;
    }
    const totals = new Map<string, number>();
    for (const [index, document] of documents.entries()) {
      const terms = new Set<string>();
      for (const field of document.fields) {
        totals.set(
          field.name,
          (totals.get(field.name) ?? 0) + field.tokens.length,
        );
        for (const token of field.tokens) {
          terms.add(token);
          const ids = this.inverted.get(token) ?? new Set<number>();
          ids.add(index);
          this.inverted.set(token, ids);
        }
      }
      if (terms.size === 0)
        throw new Error(`Search document '${document.name}' has no tokens.`);
    }
    this.documents = documents;
    for (const [term, ids] of this.inverted)
      this.documentFrequency.set(term, ids.size);
    for (const [field, total] of totals)
      this.averageFieldLength.set(field, total / documents.length);
  }

  search(query: string, limit: number): WeightedSearchResult<T>[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
      throw new Error('Search limit must be an integer from 1 to 8.');
    }
    const queryTokens = tokenize(query);
    if (query.trim() === '' || queryTokens.length === 0) {
      throw new Error('Search query must contain searchable text.');
    }
    const termMatches = queryTokens.map((token) => this.matchTerms(token));
    const candidates = new Set<number>();
    for (const matches of termMatches) {
      for (const match of matches) {
        for (const id of this.inverted.get(match.term) ?? [])
          candidates.add(id);
      }
    }
    return [...candidates]
      .map((id) => this.score(id, queryTokens, termMatches))
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.name.localeCompare(right.name),
      )
      .slice(0, limit)
      .map(({ value, matchedBy, score }) => ({ value, matchedBy, score }));
  }

  private matchTerms(queryToken: string) {
    const matches = new Map<string, TermMatch>();
    if (this.inverted.has(queryToken))
      matches.set(queryToken, {
        term: queryToken,
        kind: 'exact',
        multiplier: 3,
      });
    for (const term of this.inverted.keys()) {
      if (
        queryToken.length >= 2 &&
        term.startsWith(queryToken) &&
        term !== queryToken
      ) {
        matches.set(term, { term, kind: 'prefix', multiplier: 1.5 });
        continue;
      }
      const maxDistance =
        queryToken.length >= 10 ? 2 : queryToken.length >= 4 ? 1 : 0;
      if (
        maxDistance > 0 &&
        Math.abs(term.length - queryToken.length) <= maxDistance &&
        boundedLevenshtein(term, queryToken, maxDistance) <= maxDistance &&
        !matches.has(term)
      ) {
        matches.set(term, { term, kind: 'fuzzy', multiplier: 0.7 });
      }
    }
    return [...matches.values()];
  }

  private score(
    id: number,
    queryTokens: readonly string[],
    termMatches: readonly (readonly TermMatch[])[],
  ): WeightedSearchResult<T> & { readonly name: string } {
    const document = this.documents[id];
    if (document === undefined)
      throw new Error(`Search index references missing document ${id}.`);
    let score = 0;
    let covered = 0;
    const matchedBy = new Set<string>();
    for (const [queryIndex, matches] of termMatches.entries()) {
      let queryScore = 0;
      for (const match of matches) {
        for (const field of document.fields) {
          const frequency = field.tokens.filter(
            (token) => token === match.term,
          ).length;
          if (frequency === 0) continue;
          const documentFrequency = this.documentFrequency.get(match.term);
          const averageLength = this.averageFieldLength.get(field.name);
          if (
            documentFrequency === undefined ||
            averageLength === undefined ||
            averageLength <= 0
          )
            continue;
          const idf = Math.log(
            1 +
              (this.documents.length - documentFrequency + 0.5) /
                (documentFrequency + 0.5),
          );
          const normalization =
            frequency +
            1.2 * (0.25 + (0.75 * field.tokens.length) / averageLength);
          queryScore +=
            field.weight *
            match.multiplier *
            idf *
            ((frequency * 2.2) / normalization + 0.5);
          matchedBy.add(`${field.name}:${match.kind}`);
        }
      }
      if (queryScore > 0) {
        covered += 1;
        score += queryScore;
      }
      if (queryTokens[queryIndex] === document.name) score += 100;
    }
    return {
      value: document.value,
      name: document.name,
      matchedBy: [...matchedBy].sort(),
      score: Number((score * (covered / queryTokens.length)).toFixed(6)),
    };
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function tokenize(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function boundedLevenshtein(
  left: string,
  right: string,
  maxDistance: number,
): number {
  if (Math.abs(left.length - right.length) > maxDistance)
    return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMinimum = current[0]!;
    for (let j = 1; j <= right.length; j += 1) {
      const value = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length]!;
}
