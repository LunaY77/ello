import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Subagent 配置。 */
export interface SubagentConfig {
  name: string;
  description: string;
  instruction: string | null;
  systemPrompt: string;
  tools: string[] | null;
  optionalTools: string[] | null;
  model: string | null;
  modelSettings: string | Record<string, unknown> | null;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/** 从 YAML frontmatter + markdown body 解析 SubagentConfig。 */
export function parseSubagentMarkdown(content: string): SubagentConfig {
  const match = FRONTMATTER_RE.exec(content.trim());
  if (match === null) {
    throw new Error(
      "Invalid markdown format: expected YAML frontmatter delimited by '---'",
    );
  }

  const frontmatter = parseFrontmatter(match[1] ?? '');
  if (!frontmatter.has('name')) {
    throw new Error("Missing required field 'name' in frontmatter");
  }
  if (!frontmatter.has('description')) {
    throw new Error("Missing required field 'description' in frontmatter");
  }

  return {
    name: frontmatter.get('name') as string,
    description: frontmatter.get('description') as string,
    instruction: scalarOrNull(frontmatter.get('instruction')),
    systemPrompt: (match[2] ?? '').trim(),
    tools: listOrNull(frontmatter.get('tools')),
    optionalTools: listOrNull(frontmatter.get('optional_tools')),
    model: scalarOrNull(frontmatter.get('model')),
    modelSettings: modelSettingsOrNull(frontmatter.get('model_settings')),
  };
}

/** 从文件加载 SubagentConfig。 */
export async function loadSubagentFromFile(
  filePath: string,
): Promise<SubagentConfig> {
  return parseSubagentMarkdown(await readFile(filePath, 'utf8'));
}

/** 从目录加载所有 SubagentConfig。 */
export async function loadSubagentsFromDir(
  dirPath: string,
): Promise<Record<string, SubagentConfig>> {
  try {
    const directoryStat = await stat(dirPath);
    if (!directoryStat.isDirectory()) {
      return {};
    }
  } catch {
    return {};
  }

  const configs: Record<string, SubagentConfig> = {};
  for (const entry of (await readdir(dirPath))
    .filter((item) => item.endsWith('.md'))
    .sort()) {
    try {
      const config = await loadSubagentFromFile(path.join(dirPath, entry));
      configs[config.name] = config;
    } catch {
      continue;
    }
  }
  return configs;
}

function parseFrontmatter(text: string): Map<string, unknown> {
  const lines = text.split('\n');
  const values = new Map<string, unknown>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    const listMatch = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (listMatch) {
      const items: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? '';
        const itemMatch = /^\s*-\s+(.+?)\s*$/.exec(next);
        if (!itemMatch) {
          break;
        }
        items.push(unquoteScalar(itemMatch[1] ?? ''));
        index += 1;
      }
      values.set(listMatch[1] as string, items);
      continue;
    }

    const separator = line.indexOf(':');
    if (separator < 0) {
      throw new Error('Invalid YAML in frontmatter');
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values.set(key, unquoteScalar(value));
  }
  return values;
}

function listOrNull(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string' && value.length > 0) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return null;
}

function scalarOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function modelSettingsOrNull(
  value: unknown,
): string | Record<string, unknown> | null {
  if (typeof value === 'string') {
    return value.length > 0 ? value : null;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function unquoteScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
