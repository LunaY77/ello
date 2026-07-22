/**
 * 本文件负责 agent feature 的“markdown-loader”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { errnoCode } from '../../../infra/filesystem.js';
import {
  globalAgentsDir,
  parseYamlConfig,
  projectAgentsDir,
} from '../../config/index.js';

import {
  MarkdownAgentFrontmatterSchema,
  agentDefinitionFromMarkdown,
  type CodingAgentDefinition,
  type CodingAgentSource,
} from './schema.js';

/**
 * 加载 Markdown agent 定义。
 *
 * 目录优先级：bundled < global(`~/.ello/agents`) < project(`<cwd>/.ello/agents`)，同名时
 * 高优先级定义覆盖低优先级定义。frontmatter
 * 由 {@link MarkdownAgentFrontmatterSchema} 破坏性校验；正文即 prompt。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - Promise 在 产品 Agent `markdown-loader` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 产品 Agent `markdown-loader` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function loadMarkdownAgents(
  cwd: string,
): Promise<readonly CodingAgentDefinition[]> {
  return [
    ...(await loadFromDir(bundledAgentsDir(), 'bundled')),
    ...(await loadFromDir(globalAgentsDir(), 'global')),
    ...(await loadFromDir(projectAgentsDir(cwd), 'project')),
  ];
}

function bundledAgentsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundled');
}

async function loadFromDir(
  dir: string,
  source: CodingAgentSource,
): Promise<CodingAgentDefinition[]> {
  const entries = await readDirOrEmpty(dir);
  const definitions: CodingAgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const raw = await readFile(filePath, 'utf8');
    const { frontmatter, body } = parseMarkdown(raw, filePath);
    definitions.push(
      agentDefinitionFromMarkdown({
        frontmatter: MarkdownAgentFrontmatterSchema.parse(frontmatter),
        body,
        defaultName: path.basename(entry, '.md'),
        source,
      }),
    );
  }
  return definitions;
}

/** 目录不存在表示没有该层级的 Markdown agent 定义。 */
async function readDirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** 拆出 YAML frontmatter 与正文；缺 frontmatter 直接抛错，不静默兜底。 */
function parseMarkdown(
  raw: string,
  filePath: string,
): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  if (!raw.startsWith('---\n')) {
    throw new Error(
      `Agent markdown must start with YAML frontmatter: ${filePath}`,
    );
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error(`Agent markdown frontmatter is not closed: ${filePath}`);
  }
  return {
    frontmatter: parseYamlConfig(raw.slice(4, end)),
    body: raw.slice(end + 4).replace(/^\r?\n/u, ''),
  };
}
