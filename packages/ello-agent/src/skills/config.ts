import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** 技能配置。 */
export interface SkillConfig {
  /** 技能名称。 */
  name: string;
  /** 技能描述。 */
  description: string;
  /** 技能正文 markdown 内容。 */
  body: string;
  /** 来源文件路径。 */
  sourcePath: string | null;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/**
 * 解析 markdown 技能文件。
 *
 * Args:
 *   text: markdown 文件全文。
 *   sourcePath: 来源文件路径。
 *
 * Returns:
 *   SkillConfig 实例。
 *
 * Raises:
 *   Error: frontmatter 缺失或缺少 name 时抛出。
 */
export function parseSkillMarkdown(
  text: string,
  options: { sourcePath?: string | null } = {},
): SkillConfig {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    throw new Error('Skill markdown must start with YAML frontmatter (---)');
  }

  const frontmatter = parseFrontmatter(match[1] ?? '');
  const name = frontmatter.get('name');
  const description = frontmatter.get('description') ?? '';
  if (!name) {
    throw new Error("Skill frontmatter must include 'name'");
  }

  return {
    name,
    description,
    body: text.slice(match[0].length).trim(),
    sourcePath: options.sourcePath ?? null,
  };
}

/**
 * 从文件加载技能配置。
 *
 * Args:
 *   filePath: markdown 文件路径。
 */
export async function loadSkillFromFile(
  filePath: string,
): Promise<SkillConfig> {
  const text = await readFile(filePath, 'utf8');
  return parseSkillMarkdown(text, { sourcePath: filePath });
}

/**
 * 从目录加载所有 .md 技能文件。
 *
 * 无效文件会被跳过, 与 Python 版保持一致。
 */
export async function loadSkillsFromDir(
  directory: string,
): Promise<SkillConfig[]> {
  try {
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const entries = await readdir(directory);
  const skills: SkillConfig[] = [];
  for (const entry of entries.filter((item) => item.endsWith('.md')).sort()) {
    try {
      skills.push(await loadSkillFromFile(path.join(directory, entry)));
    } catch {
      continue;
    }
  }
  return skills;
}

function parseFrontmatter(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = unquoteYamlScalar(line.slice(separator + 1).trim());
    values.set(key, value);
  }
  return values;
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
