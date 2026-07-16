/**
 * 工具发现索引：把少量 AgentTool 定义转换成可重复、可解释的本地搜索结构。
 *
 * 算法流程分为四步：
 * 1. 构建阶段读取工具自身的 discovery metadata 和 Zod input schema，生成不可变的
 *    ToolIndexDocument；同时建立 term -> toolId 的倒排表，并统计每个字段的长度、
 *    平均长度和文档频率。索引不读取工作区，也不执行工具。
 * 2. 文本归一化使用 Unicode NFKC、小写转换和 Unicode 字母/数字分词。name、aliases、
 *    description、schema 属性/描述、risk 分别作为字段，权重固定为 8、5、3、2、1；
 *    权重越高表示该字段越能代表工具能力。空名称、空描述、空 alias、重复名称、
 *    alias 冲突、tool_search/call_tool 名称冲突或 schema 无法转成 JSON Schema 都在构建时直接报错。
 * 3. 查询先按 OR 语义合并各 token 的候选工具，再对每个候选计算字段化 BM25 分数。
 *    exact 匹配倍率为 3，prefix 匹配倍率为 1.5，fuzzy 匹配倍率为 0.7，因此同一
 *    字段中 exact 必然优先于 prefix，prefix 优先于 fuzzy。prefix 至少需要 2 个字符；
 *    fuzzy 至少需要 4 个字符，默认最大编辑距离为 1，token 长度达到 10 时放宽为 2。
 *    有界 Levenshtein 在当前行最小值超过阈值时立即剪枝，避免无界计算。
 * 4. 多 token 结果按覆盖 token 数占比衰减，最后按 score 降序、name 升序排序并截断到
 *    limit。name 升序是稳定性保障，确保相同输入在不同运行中产生相同顺序。
 *
 * 工具数量通常只有几十个，因此这里刻意不引入持久化、增量更新、复杂查询语法或
 * radix tree；一次性倒排表加线性 fuzzy 扫描更容易审计，也足以满足 runtime 搜索成本。
 */
import type { AnyAgentTool, ToolRisk } from '@ello/agent';
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export interface ToolIndexDocument {
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly risk: ToolRisk;
  readonly inputSchema: JsonSchema;
}

export interface ToolSearchResult extends ToolIndexDocument {
  readonly matchedBy: readonly string[];
  readonly score: number;
}

/** 索引字段及其权重；name 权重最高，schema 只用于辅助匹配。 */
interface IndexedField {
  readonly name: string;
  readonly weight: number;
  readonly tokens: readonly string[];
}

interface IndexedDocument {
  readonly document: ToolIndexDocument;
  readonly fields: readonly IndexedField[];
}

/** 搜索索引永远不收录 tool_search 和 call_tool 本身。 */
const META_TOOL_NAMES = new Set(['tool_search', 'call_tool']);
const FIELD_WEIGHTS = {
  name: 8,
  aliases: 5,
  description: 3,
  schema: 2,
  risk: 1,
} as const;

export class ToolSearchIndex {
  private readonly documents: readonly IndexedDocument[];
  private readonly inverted: ReadonlyMap<string, ReadonlySet<number>>;
  private readonly documentFrequency: ReadonlyMap<string, number>;
  private readonly averageFieldLength: ReadonlyMap<string, number>;

  constructor(tools: readonly AnyAgentTool[]) {
    // 构建阶段一次性校验工具定义，并建立倒排表和 BM25 所需的统计量。
    const documents = buildDocuments(tools);
    const inverted = new Map<string, Set<number>>();
    const fieldTotals = new Map<string, number>();
    for (const [toolId, indexed] of documents.entries()) {
      const documentTerms = new Set<string>();
      for (const field of indexed.fields) {
        fieldTotals.set(
          field.name,
          (fieldTotals.get(field.name) ?? 0) + field.tokens.length,
        );
        for (const token of field.tokens) {
          documentTerms.add(token);
          const ids = inverted.get(token) ?? new Set<number>();
          ids.add(toolId);
          inverted.set(token, ids);
        }
      }
      if (documentTerms.size === 0) {
        throw new Error(`Tool '${indexed.document.name}' has no index tokens.`);
      }
    }
    this.documents = documents;
    this.inverted = inverted;
    this.documentFrequency = new Map(
      [...inverted].map(([term, ids]) => [term, ids.size]),
    );
    this.averageFieldLength = new Map(
      [...fieldTotals].map(([field, total]) => [
        field,
        total / documents.length,
      ]),
    );
  }

  search(query: string, limit: number): ToolSearchResult[] {
    // 多 token 查询采用 OR 候选集，最终分数再按 token 覆盖率衰减。
    const queryTokens = tokenize(query);
    if (query.trim() === '' || queryTokens.length === 0) {
      throw new Error('Tool search query must contain searchable text.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
      throw new Error('Tool search limit must be an integer from 1 to 8.');
    }

    const termMatches = queryTokens.map((queryToken) =>
      this.matchTerms(queryToken),
    );
    const candidates = new Set<number>();
    for (const matches of termMatches) {
      for (const match of matches) {
        for (const toolId of this.inverted.get(match.term) ?? []) {
          candidates.add(toolId);
        }
      }
    }

    return [...candidates]
      .map((toolId) => this.scoreDocument(toolId, queryTokens, termMatches))
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.name.localeCompare(right.name),
      )
      .slice(0, limit);
  }

  private matchTerms(queryToken: string): Array<{
    readonly term: string;
    readonly kind: 'exact' | 'prefix' | 'fuzzy';
    readonly multiplier: number;
  }> {
    // exact、prefix、fuzzy 使用递减倍率；短词不启用 fuzzy，避免噪声匹配。
    const matches = new Map<
      string,
      { term: string; kind: 'exact' | 'prefix' | 'fuzzy'; multiplier: number }
    >();
    if (this.inverted.has(queryToken)) {
      matches.set(queryToken, {
        term: queryToken,
        kind: 'exact',
        multiplier: 3,
      });
    }
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

  private scoreDocument(
    toolId: number,
    queryTokens: readonly string[],
    termMatches: readonly (readonly {
      term: string;
      kind: 'exact' | 'prefix' | 'fuzzy';
      multiplier: number;
    }[])[],
  ): ToolSearchResult {
    // 每个字段独立计算 BM25，再乘字段权重和匹配类型倍率。
    const indexed = this.documents[toolId];
    if (indexed === undefined) {
      throw new Error(`Tool index references missing document ${toolId}.`);
    }
    let score = 0;
    let covered = 0;
    const matchedBy = new Set<string>();
    for (const [queryIndex, matches] of termMatches.entries()) {
      let queryScore = 0;
      for (const match of matches) {
        for (const field of indexed.fields) {
          const frequency = field.tokens.filter(
            (token) => token === match.term,
          ).length;
          if (frequency === 0) {
            continue;
          }
          const documentFrequency = this.documentFrequency.get(match.term);
          if (documentFrequency === undefined) {
            throw new Error(`Missing document frequency for '${match.term}'.`);
          }
          const averageLength = this.averageFieldLength.get(field.name);
          if (averageLength === undefined || averageLength <= 0) {
            throw new Error(
              `Missing average length for field '${field.name}'.`,
            );
          }
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
      if (queryTokens[queryIndex] === indexed.document.name) {
        score += 100;
      }
    }
    score *= covered / queryTokens.length;
    return {
      ...indexed.document,
      matchedBy: [...matchedBy].sort(),
      score: Number(score.toFixed(6)),
    };
  }
}

export function createToolSearchIndex(
  tools: readonly AnyAgentTool[],
): ToolSearchIndex {
  return new ToolSearchIndex(tools);
}

function buildDocuments(tools: readonly AnyAgentTool[]): IndexedDocument[] {
  // discovery metadata 是索引唯一数据源，禁止从工具名推断风险或别名。
  if (tools.length === 0) {
    throw new Error('Tool search index requires at least one target tool.');
  }
  const names = new Set<string>();
  const aliases = new Map<string, string>();
  const documents: IndexedDocument[] = [];
  for (const tool of tools) {
    const name = tool.name.trim();
    const description = tool.description.trim();
    if (name === '' || description === '') {
      throw new Error(
        'Indexed tools require non-empty names and descriptions.',
      );
    }
    if (META_TOOL_NAMES.has(name)) {
      throw new Error(`Target tool name conflicts with meta tool: ${name}`);
    }
    if (names.has(name)) {
      throw new Error(`Duplicate indexed tool name: ${name}`);
    }
    names.add(name);
    if (tool.discovery === undefined) {
      throw new Error(`Tool '${name}' is missing discovery metadata.`);
    }
    if (!Array.isArray(tool.discovery.aliases)) {
      throw new Error(`Tool '${name}' aliases must be an array.`);
    }
    if (tool.discovery.aliases.length === 0) {
      throw new Error(`Tool '${name}' requires at least one alias.`);
    }
    if (
      !['readonly', 'workspace-write', 'external'].includes(tool.discovery.risk)
    ) {
      throw new Error(`Tool '${name}' has an invalid discovery risk.`);
    }
    const localAliases = new Set<string>();
    const normalizedAliases = tool.discovery.aliases.map((alias) => {
      const normalized = alias.trim();
      if (normalized === '') {
        throw new Error(`Tool '${name}' contains an empty alias.`);
      }
      const key = normalize(normalized);
      if (localAliases.has(key)) {
        throw new Error(
          `Tool '${name}' contains duplicate alias '${normalized}'.`,
        );
      }
      localAliases.add(key);
      const owner = aliases.get(key);
      if (owner !== undefined && owner !== name) {
        throw new Error(`Alias '${normalized}' points to multiple tools.`);
      }
      aliases.set(key, name);
      return normalized;
    });
    const inputSchema = schemaFor(tool);
    const schemaText = schemaIndexText(inputSchema);
    const fields = [
      field('name', FIELD_WEIGHTS.name, name),
      field('aliases', FIELD_WEIGHTS.aliases, normalizedAliases.join(' ')),
      field('description', FIELD_WEIGHTS.description, description),
      field('schema', FIELD_WEIGHTS.schema, schemaText || name),
      field('risk', FIELD_WEIGHTS.risk, tool.discovery.risk),
    ];
    documents.push({
      document: {
        name,
        description,
        aliases: normalizedAliases,
        risk: tool.discovery.risk,
        inputSchema,
      },
      fields,
    });
  }
  for (const name of names) {
    const owner = aliases.get(normalize(name));
    if (owner !== undefined && owner !== name) {
      throw new Error(`Alias '${name}' conflicts with tool name '${name}'.`);
    }
  }
  return documents;
}

function schemaFor(tool: AnyAgentTool): JsonSchema {
  try {
    const schema = z.toJSONSchema(tool.input);
    JSON.stringify(schema);
    return schema as JsonSchema;
  } catch (error) {
    throw new Error(
      `Cannot serialize input schema for tool '${tool.name}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function schemaIndexText(schema: JsonSchema): string {
  // 只提取属性名和描述，避免把完整 schema JSON 重复塞进倒排词表。
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.description === 'string') {
        parts.push(record.description);
      }
      if (
        typeof record.properties === 'object' &&
        record.properties !== null &&
        !Array.isArray(record.properties)
      ) {
        for (const [propertyName, propertySchema] of Object.entries(
          record.properties,
        )) {
          parts.push(propertyName);
          visit(propertySchema);
        }
      }
      if (record.items !== undefined) visit(record.items);
      for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
        if (record[key] !== undefined) visit(record[key]);
      }
    }
  };
  visit(schema);
  return parts.join(' ');
}

function field(name: string, weight: number, value: string): IndexedField {
  const tokens = tokenize(value);
  if (tokens.length === 0) {
    throw new Error(`Tool index field '${name}' has no searchable tokens.`);
  }
  return { name, weight, tokens };
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function boundedLevenshtein(
  left: string,
  right: string,
  maxDistance: number,
): number {
  // 行最小值超过阈值时提前结束，保证 fuzzy 搜索有固定成本上界。
  if (Math.abs(left.length - right.length) > maxDistance) {
    return maxDistance + 1;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}
