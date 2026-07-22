/**
 * 本文件负责 memory feature 的运行时 schema 与派生类型。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { Buffer } from 'node:buffer';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

export const MEMORY_INDEX_FILE = 'MEMORY.md';
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
export const MEMORY_INDEX_MAX_LINE_LENGTH = 200;

export const MemoryTopicTypeSchema = z.enum([
  'user',
  'feedback',
  'project',
  'reference',
]);

export const MemoryTopicFrontmatterSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    type: MemoryTopicTypeSchema,
  })
  .strict();

export type MemoryTopicType = z.infer<typeof MemoryTopicTypeSchema>;
export type MemoryTopicFrontmatter = z.infer<
  typeof MemoryTopicFrontmatterSchema
>;

export interface MemoryTopicDocument {
  readonly frontmatter: MemoryTopicFrontmatter;
  readonly body: string;
}

export interface MemoryIndexEntry {
  readonly name: string;
  readonly file: string;
  readonly description: string;
}

const TOPIC_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.md$/u;
const INDEX_LINE_PATTERN =
  /^- \[([^\]\n]+)\]\(([a-z0-9][a-z0-9-]*\.md)\) — ([^\n]+)$/u;

/**
 * 校验 Memory `schema` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `file`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - Memory `schema` 模块 的同步状态变更完成后返回，不产生业务结果。
 *
 * Throws:
 * - 当 Memory `schema` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function assertMemoryTopicFile(file: string): void {
  if (file === MEMORY_INDEX_FILE || !TOPIC_FILE_PATTERN.test(file)) {
    throw new Error(
      `Invalid memory topic file: ${file}. Use a top-level kebab-case Markdown file.`,
    );
  }
}

/**
 * 校验 Memory `schema` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `content`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - 返回 `parseMemoryTopic` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Memory `schema` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseMemoryTopic(content: string): MemoryTopicDocument {
  if (!content.startsWith('---\n')) {
    throw new Error('Memory topic must start with YAML frontmatter.');
  }
  const delimiter = content.indexOf('\n---\n', 4);
  if (delimiter < 0) {
    throw new Error('Memory topic frontmatter is not terminated.');
  }
  const rawFrontmatter = content.slice(4, delimiter);
  const parsed = MemoryTopicFrontmatterSchema.parse(parseYaml(rawFrontmatter));
  if (parsed.description.includes('\n')) {
    throw new Error('Memory topic description must be one line.');
  }
  const body = content.slice(delimiter + 5).trim();
  if (body === '') {
    throw new Error('Memory topic body must not be empty.');
  }
  if (
    (parsed.type === 'feedback' || parsed.type === 'project') &&
    (!body.includes('**Why:**') || !body.includes('**How to apply:**'))
  ) {
    throw new Error(
      `${parsed.type} memory must contain **Why:** and **How to apply:** lines.`,
    );
  }
  return { frontmatter: parsed, body };
}

/**
 * 执行 Memory `schema` 模块 定义的 `renderMemoryTopic` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `document`: `renderMemoryTopic` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `renderMemoryTopic` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function renderMemoryTopic(document: MemoryTopicDocument): string {
  const frontmatter = stringifyYaml(document.frontmatter, {
    lineWidth: 0,
  }).trim();
  return `---\n${frontmatter}\n---\n\n${document.body.trim()}\n`;
}

/**
 * 校验 Memory `schema` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `content`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 *
 * Throws:
 * - 当 Memory `schema` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function parseMemoryIndex(content: string): MemoryIndexEntry[] {
  validateMemoryIndexLimits(content);
  if (content.trim() === '') {
    return [];
  }
  return content
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      const match = INDEX_LINE_PATTERN.exec(line);
      if (match === null) {
        throw new Error(`Invalid MEMORY.md entry at line ${index + 1}.`);
      }
      const [, name, file, description] = match;
      if (
        name === undefined ||
        file === undefined ||
        description === undefined
      ) {
        throw new Error(
          `Invalid MEMORY.md capture groups at line ${index + 1}.`,
        );
      }
      return {
        name,
        file,
        description,
      };
    });
}

/**
 * 执行 Memory `schema` 模块 定义的 `renderMemoryIndex` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `entries`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `renderMemoryIndex` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function renderMemoryIndex(
  entries: readonly MemoryIndexEntry[],
): string {
  const content = entries
    .map((entry) => `- [${entry.name}](${entry.file}) — ${entry.description}`)
    .join('\n');
  const rendered = content === '' ? '' : `${content}\n`;
  validateMemoryIndexLimits(rendered);
  parseMemoryIndex(rendered);
  return rendered;
}

function validateMemoryIndexLimits(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MEMORY_INDEX_MAX_BYTES) {
    throw new Error('MEMORY.md exceeds the 25KB limit.');
  }
  const lines = content.trimEnd() === '' ? [] : content.trimEnd().split('\n');
  if (lines.length > MEMORY_INDEX_MAX_LINES) {
    throw new Error('MEMORY.md exceeds the 200 line limit.');
  }
  const longLine = lines.findIndex(
    (line) => line.length > MEMORY_INDEX_MAX_LINE_LENGTH,
  );
  if (longLine >= 0) {
    throw new Error(
      `MEMORY.md line ${longLine + 1} exceeds ${MEMORY_INDEX_MAX_LINE_LENGTH} characters.`,
    );
  }
}
