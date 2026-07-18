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

export function assertMemoryTopicFile(file: string): void {
  if (file === MEMORY_INDEX_FILE || !TOPIC_FILE_PATTERN.test(file)) {
    throw new Error(
      `Invalid memory topic file: ${file}. Use a top-level kebab-case Markdown file.`,
    );
  }
}

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

export function renderMemoryTopic(document: MemoryTopicDocument): string {
  const frontmatter = stringifyYaml(document.frontmatter, {
    lineWidth: 0,
  }).trim();
  return `---\n${frontmatter}\n---\n\n${document.body.trim()}\n`;
}

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
      return {
        name: match[1]!,
        file: match[2]!,
        description: match[3]!,
      };
    });
}

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
