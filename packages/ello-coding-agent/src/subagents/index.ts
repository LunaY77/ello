import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AnyAgentTool, SubagentDefinition } from '@ello/agent';

import type { CodingAgentConfig } from '../config/index.js';
import { globalSubagentsDir, projectSubagentsDir } from '../session/paths.js';
import { createFsTools } from '../tools/fs.js';
import { adaptCodingTools } from '../tools/runtime/adapter.js';
import { SessionToolOutputStore } from '../tools/runtime/output-store.js';
import { createSearchTools } from '../tools/search.js';
import type { ApprovalFor } from '../tools/shared.js';

interface SubagentMarkdown {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools?: readonly string[];
  readonly inheritTools: boolean;
  readonly baseDir: string;
  readonly source: 'bundled' | 'global' | 'project';
  readonly contentHash: string;
  readonly frontmatter: Record<string, unknown>;
}

function bundledSubagentsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundled');
}

/**
 * 加载 coding-agent 可委派子代理。
 *
 * 子代理定义使用 Claude Code / YAACLI 风格的 Markdown 文件：frontmatter 是
 * metadata，正文是系统提示。内置、全局、项目定义按 bundled < global < project
 * 覆盖，同名高优先级定义覆盖低优先级定义。
 */
export async function codingSubagents(
  config: CodingAgentConfig,
): Promise<SubagentDefinition[]> {
  const tools = readOnlyTools(config);
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  const loaded = [
    ...(await safeLoad(bundledSubagentsDir(), 'bundled')),
    ...(await safeLoad(globalSubagentsDir(), 'global')),
    ...(await safeLoad(projectSubagentsDir(config.cwd), 'project')),
  ];
  return dedupeByName(loaded).map((item) => ({
    name: item.name,
    description: item.description,
    instructions: item.instructions,
    inheritTools: item.inheritTools,
    tools: selectTools(item.tools, available),
    metadata: {
      source: item.source,
      baseDir: item.baseDir,
      contentHash: item.contentHash,
      frontmatter: item.frontmatter,
    },
  }));
}

async function safeLoad(
  dir: string,
  source: SubagentMarkdown['source'],
): Promise<SubagentMarkdown[]> {
  try {
    return await loadSubagentsFromDir(dir, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function loadSubagentsFromDir(
  dir: string,
  source: SubagentMarkdown['source'],
): Promise<SubagentMarkdown[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const subagents: SubagentMarkdown[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    subagents.push(await loadSubagentFromFile(filePath, source));
  }
  return subagents;
}

async function loadSubagentFromFile(
  filePath: string,
  source: SubagentMarkdown['source'],
): Promise<SubagentMarkdown> {
  const raw = await readFile(filePath, 'utf8');
  const { frontmatter, body } = parseMarkdown(raw);
  const name =
    readString(frontmatter, 'name') ??
    path.basename(filePath, path.extname(filePath));
  const description = readString(frontmatter, 'description');
  if (description === undefined) {
    throw new Error(`Subagent ${filePath} is missing description.`);
  }
  const tools =
    readStringArray(frontmatter, 'tools') ??
    readStringArray(frontmatter, 'allowed-tools');
  return {
    name,
    description,
    instructions: body.trim(),
    inheritTools:
      readBoolean(frontmatter, 'inheritTools') ??
      readBoolean(frontmatter, 'inherit-tools') ??
      false,
    baseDir: path.dirname(filePath),
    source,
    contentHash: createHash('sha1').update(raw).digest('hex'),
    frontmatter,
    ...(tools !== undefined ? { tools } : {}),
  };
}

function selectTools(
  requested: readonly string[] | undefined,
  available: ReadonlyMap<string, AnyAgentTool>,
): AnyAgentTool[] {
  const names = requested ?? ['read', 'ls', 'grep', 'glob'];
  return names
    .map((name) => available.get(name))
    .filter((tool): tool is AnyAgentTool => tool !== undefined);
}

function dedupeByName(
  subagents: readonly SubagentMarkdown[],
): SubagentMarkdown[] {
  const byName = new Map<string, SubagentMarkdown>();
  for (const subagent of subagents) {
    byName.set(subagent.name, subagent);
  }
  return [...byName.values()];
}

function parseMarkdown(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  if (!raw.startsWith('---\n')) {
    throw new Error('Subagent markdown must start with YAML frontmatter.');
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error('Subagent markdown frontmatter is not closed.');
  }
  return {
    frontmatter: parseSimpleYaml(raw.slice(4, end)),
    body: raw.slice(end + 4).replace(/^\r?\n/u, ''),
  };
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (match === null) {
      continue;
    }
    const key = match[1]!;
    const rawValue = match[2]!;
    if (rawValue === '') {
      const values: string[] = [];
      while (lines[index + 1]?.match(/^\s*-\s+/u)) {
        index += 1;
        values.push(lines[index]!.replace(/^\s*-\s+/u, '').trim());
      }
      result[key] = values;
    } else {
      result[key] = parseScalar(rawValue);
    }
  }
  return result;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed.replace(/^["']|["']$/gu, '');
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const item = value[key];
  return typeof item === 'string' && item.length > 0 ? item : undefined;
}

function readStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const item = value[key];
  if (Array.isArray(item)) {
    return item.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof item === 'string') {
    return item
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
  }
  return undefined;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const item = value[key];
  return typeof item === 'boolean' ? item : undefined;
}

function readOnlyTools(config: CodingAgentConfig): AnyAgentTool[] {
  const autoApproval: ApprovalFor = () => () => 'auto';
  const readOnlyNames = new Set(['read', 'ls', 'grep', 'glob']);
  const tools = [
    ...createFsTools(config, autoApproval),
    ...createSearchTools(config, autoApproval),
  ].filter((tool) => readOnlyNames.has(tool.name));
  return adaptCodingTools(tools, {
    config,
    outputStore: new SessionToolOutputStore(config.sessionDir),
  });
}
