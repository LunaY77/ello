/**
 * ToolSearchIndex 是工具领域到 WeightedSearchIndex 的薄适配层。
 * 这里只校验 discovery metadata、序列化 Zod schema，并定义工具字段权重；
 * 文本归一化、BM25、前缀/模糊匹配和稳定排序全部由通用索引实现，避免与 Skill
 * 搜索维护两套逐渐漂移的算法。
 */
import type { AnyAgentTool, ToolRisk } from '@ello/agent';
import { z } from 'zod';

import {
  WeightedSearchIndex,
  type WeightedSearchField,
} from './weighted-search-index.js';

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

export type ToolInventoryItem = Omit<ToolIndexDocument, 'inputSchema'>;

interface ToolSearchSource {
  readonly document: ToolIndexDocument;
  readonly fields: readonly WeightedSearchField[];
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
  private readonly sources: readonly ToolSearchSource[];
  private readonly index: WeightedSearchIndex<ToolSearchSource>;

  constructor(tools: readonly AnyAgentTool[]) {
    // 工具层只负责 schema/discovery 校验和字段映射，排序算法统一由通用索引承担。
    this.sources = buildDocuments(tools);
    this.index = new WeightedSearchIndex(
      this.sources,
      (source) => source.fields,
      (source) => source.document.name,
    );
  }

  get size(): number {
    return this.sources.length;
  }

  list(limit: number, offset = 0): ToolInventoryItem[] {
    assertLimit(limit);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('Tool inventory offset must be a non-negative integer.');
    }
    return this.sources
      .map(({ document }) => inventoryItem(document))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(offset, offset + limit);
  }

  search(query: string, limit: number): ToolSearchResult[] {
    if (query.trim() === '' || !hasSearchToken(query)) {
      throw new Error('Tool search query must contain searchable text.');
    }
    assertLimit(limit);
    return this.index.search(query, limit).map((result) => ({
      ...result.value.document,
      matchedBy: result.matchedBy,
      score: result.score,
    }));
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
    throw new Error('Tool search limit must be an integer from 1 to 8.');
  }
}

function inventoryItem(document: ToolIndexDocument): ToolInventoryItem {
  const { inputSchema: _inputSchema, ...item } = document;
  return item;
}

export function createToolSearchIndex(
  tools: readonly AnyAgentTool[],
): ToolSearchIndex {
  return new ToolSearchIndex(tools);
}

function buildDocuments(tools: readonly AnyAgentTool[]): ToolSearchSource[] {
  // discovery metadata 是索引唯一数据源，禁止从工具名推断风险或别名。
  if (tools.length === 0) {
    throw new Error('Tool search index requires at least one target tool.');
  }
  const names = new Set<string>();
  const aliases = new Map<string, string>();
  const documents: ToolSearchSource[] = [];
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

function field(
  name: string,
  weight: number,
  text: string,
): WeightedSearchField {
  if (!hasSearchToken(text)) {
    throw new Error(`Tool index field '${name}' has no searchable tokens.`);
  }
  return { name, weight, text };
}

function hasSearchToken(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(normalize(value));
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}
