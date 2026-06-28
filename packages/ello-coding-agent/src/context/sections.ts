import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SystemSection } from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * 系统 section 的产品层动态依赖。
 *
 * 这些回调由 {@link CodingSession} 装配时注入：section 只是“内容提供者”，
 * 真正的数据（最近压缩摘要、当前激活技能）来自会话运行时的状态。
 */
export interface ContextDeps {
  /** 最近一次压缩摘要的读取器；返回 null 表示这一轮不注入。 */
  readonly sessionSummary?: () => Promise<string | null> | string | null;
  /** 当前激活技能名列表的读取器（与 10 的技能系统协作）。 */
  readonly activeSkills?: () => Promise<readonly string[]> | readonly string[];
}

/**
 * 读取项目级指令文件正文。
 *
 * 候选链（就近优先，全部存在则依次拼接）：
 * - `<cwd>/AGENTS.md`
 * - `<cwd>/.ello/ELLO.md`
 * - `<cwd>/.ello/instructions.md`
 *
 * 读取失败（文件不存在）时跳过该候选，让 section 能在任意仓库稳定运行。
 * 其它 IO 错误照常抛出，避免静默吞掉权限/磁盘问题。
 */
export async function loadProjectInstructions(cwd: string): Promise<string> {
  const candidates = [
    path.join(cwd, 'AGENTS.md'),
    path.join(cwd, '.ello', 'ELLO.md'),
    path.join(cwd, '.ello', 'instructions.md'),
  ];
  const parts: string[] = [];
  for (const file of candidates) {
    const text = await readFileOrNull(file);
    if (text !== null && text.trim()) {
      parts.push(`# ${path.relative(cwd, file)}\n${text.trim()}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * 构造 coding-agent 的系统 section 列表。
 *
 * 注意：这里**不做** “context compiler”——裁剪/预算交给内核的
 * `modelInputBudget` + `messageTransforms`。本函数只产出有序的 section，
 * 每个 section 每轮可重算（内核会在每个 turn 重新执行）。
 *
 * 顺序即覆盖优先级（后者补充/覆盖前者）：
 * 1. 全局 `~/.ello/ELLO.md`
 * 2. 项目指令（AGENTS.md / .ello/ELLO.md / .ello/instructions.md）
 * 3. 仓库概览（目录/package.json/README，进程内缓存）
 * 4. git 状态（branch/status/最近提交，每轮重算）
 * 5. 激活技能（来自 deps）
 * 6. 最近压缩摘要（来自 deps；若压缩已把摘要写进历史则通常返回 null）
 *
 * @param config 运行时配置（提供 cwd / approvalMode / allowedPaths）。
 * @param deps   动态内容依赖（会话摘要、激活技能）。
 */
export function buildSystemSections(
  config: CodingAgentConfig,
  deps: ContextDeps = {},
): SystemSection[] {
  return [
    globalInstructionsSection(),
    projectInstructionsSection(config),
    repoOverviewSection(config),
    gitStatusSection(config),
    activeSkillsSection(deps),
    sessionSummarySection(deps),
  ];
}

/** 全局用户指令：`~/.ello/ELLO.md`（跨仓库共享）。 */
function globalInstructionsSection(): SystemSection {
  const file = path.join(homedir(), '.ello', 'ELLO.md');
  return async () => {
    const text = await readFileOrNull(file);
    return text && text.trim() ? `# Global instructions (~/.ello/ELLO.md)\n${text.trim()}` : null;
  };
}

/** 项目级指令：随仓库走，覆盖/追加全局指令。 */
function projectInstructionsSection(config: CodingAgentConfig): SystemSection {
  return async () => {
    const text = await loadProjectInstructions(config.cwd);
    return text.trim() ? text : null;
  };
}

/**
 * 仓库概览：顶层目录、package.json 摘要、README 首段。
 *
 * 内容稳定，做进程内缓存（按 cwd）；仓库结构很少在一次会话内剧变，
 * 缓存能省掉每轮的目录扫描。注意只缓存本 section 的内容，**不缓存最终 prompt**。
 */
function repoOverviewSection(config: CodingAgentConfig): SystemSection {
  let cached: string | null | undefined;
  return async () => {
    if (cached === undefined) {
      cached = await buildRepoOverview(config.cwd);
    }
    return cached;
  };
}

/** git 状态：分支 / 工作区改动 / 最近提交。每轮重算以保持新鲜。 */
function gitStatusSection(config: CodingAgentConfig): SystemSection {
  return async () => {
    const text = await loadGitContext(config.cwd);
    return text.trim() ? `# Git status\n${text}` : null;
  };
}

/** 激活技能：把当前激活的技能名注入，供模型知道可用的扩展能力。 */
function activeSkillsSection(deps: ContextDeps): SystemSection {
  return async () => {
    const skills = [...(await (deps.activeSkills?.() ?? []))];
    return skills.length > 0
      ? `# Active skills\n${skills.map((skill) => `- ${skill}`).join('\n')}`
      : null;
  };
}

/**
 * 最近压缩摘要 section。
 *
 * 仅在 deps 提供 `sessionSummary` 且返回非空时注入。注意：若压缩器已经把
 * 摘要写进历史首条消息，那种装配下就不应再提供本回调，
 * 避免摘要在 prompt 里重复出现。
 */
function sessionSummarySection(deps: ContextDeps): SystemSection {
  return async () => {
    const summary = await (deps.sessionSummary?.() ?? null);
    return summary !== null && summary.trim()
      ? `# Session summary (compacted history)\n${summary.trim()}`
      : null;
  };
}

/** 读文件，ENOENT 返回 null，其它错误抛出。 */
async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** 拼出仓库概览文本：顶层条目 + package.json 名称/脚本 + README 首段。 */
async function buildRepoOverview(cwd: string): Promise<string | null> {
  const lines: string[] = [];

  const pkg = await readFileOrNull(path.join(cwd, 'package.json'));
  if (pkg !== null) {
    try {
      const parsed = JSON.parse(pkg) as {
        name?: string;
        version?: string;
        scripts?: Record<string, string>;
      };
      const head = [parsed.name, parsed.version].filter(Boolean).join('@');
      if (head) {
        lines.push(`package: ${head}`);
      }
      const scripts = Object.keys(parsed.scripts ?? {});
      if (scripts.length > 0) {
        lines.push(`scripts: ${scripts.join(', ')}`);
      }
    } catch {
      // package.json 解析失败不影响其它概览信息。
    }
  }

  const readme = (await readFileOrNull(path.join(cwd, 'README.md'))) ?? '';
  const firstParagraph = readme.trim().split(/\n\s*\n/u)[0]?.trim();
  if (firstParagraph) {
    lines.push(`readme: ${firstParagraph.slice(0, 400)}`);
  }

  return lines.length > 0 ? `# Repository overview\n${lines.join('\n')}` : null;
}

/** 读取 git 上下文：分支、短状态、最近一条提交标题。 */
async function loadGitContext(cwd: string): Promise<string> {
  try {
    const [branch, status, log] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], { cwd, timeout: 3000 }),
      execFileAsync('git', ['status', '--short'], { cwd, timeout: 3000 }),
      execFileAsync('git', ['log', '-1', '--pretty=%h %s'], { cwd, timeout: 3000 }).catch(
        () => ({ stdout: '' }),
      ),
    ]);
    return [
      `branch: ${branch.stdout.trim() || 'detached'}`,
      'status:',
      status.stdout.trim() || '<clean>',
      log.stdout.trim() ? `latest: ${log.stdout.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}
