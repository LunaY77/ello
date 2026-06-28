import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ContextSource } from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import { loadCodingMemory, renderMemoryForPrompt } from '../memory.js';

const execFileAsync = promisify(execFile);

/** coding-agent context source 的产品层动态依赖。 */
export interface CodingContextSourceOptions {
  readonly sessionSummary?: () => Promise<string | null> | string | null;
  readonly activeSkills?: () => Promise<readonly string[]> | readonly string[];
}

/**
 * 读取项目级指令文件。
 *
 * 支持 AGENTS.md 和 .ello/instructions.md；读取失败时返回空字符串，
 * 让 context source 可以在任意仓库中稳定运行。
 */
export async function loadProjectInstructions(cwd: string): Promise<string> {
  const candidates = [path.join(cwd, 'AGENTS.md'), path.join(cwd, '.ello', 'instructions.md')];
  const parts: string[] = [];
  for (const file of candidates) {
    try {
      parts.push(`# ${path.relative(cwd, file)}\n${await readFile(file, 'utf8')}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return parts.join('\n\n');
}

/** 构造 coding-agent 的 context sources。 */
export function createCodingContextSources(
  config: CodingAgentConfig,
  options: CodingContextSourceOptions = {},
): ContextSource[] {
  return [
    {
      name: 'coding.project-instructions',
      load: async () => {
        const text = await loadProjectInstructions(config.cwd);
        return text.trim()
          ? [{ kind: 'system', source: 'project-instructions', priority: 100, scope: 'workspace', retention: 'fixed', persist: 'session', text }]
          : [];
      },
    },
    {
      name: 'coding.git',
      load: async () => {
        const text = await loadGitContext(config.cwd);
        return text.trim()
          ? [{ kind: 'system', source: 'git', priority: 40, scope: 'run', retention: 'droppable', persist: 'never', text }]
          : [];
      },
    },
    {
      name: 'coding.environment',
      load: () => [
        {
          kind: 'system',
          source: 'environment',
          priority: 80,
          scope: 'run',
          retention: 'fixed',
          persist: 'never',
          text: [
            `cwd: ${config.cwd}`,
            `date: ${new Date().toISOString()}`,
            `permissionMode: ${config.approvalMode}`,
            `allowedPaths: ${config.allowedPaths.join(', ')}`,
          ].join('\n'),
        },
      ],
    },
    {
      name: 'coding.active-skills',
      load: async () => {
        const skills = [...(await (options.activeSkills?.() ?? []))];
        return skills.length > 0
          ? [{
              kind: 'system',
              source: 'active-skills',
              priority: 70,
              scope: 'run',
              retention: 'droppable',
              persist: 'never',
              text: `active skills:\n${skills.map((skill) => `- ${skill}`).join('\n')}`,
            }]
          : [];
      },
    },
    {
      name: 'coding.session-summary',
      load: async () => {
        const summary = await (options.sessionSummary?.() ?? null);
        return summary !== null && summary.trim()
          ? [{
              kind: 'memory',
              source: 'session-summary',
              priority: 90,
              scope: 'session',
              retention: 'fixed',
              persist: 'session',
              memoryType: 'episodic',
              text: summary,
            }]
          : [];
      },
    },
    {
      name: 'coding.memory',
      load: async () => {
        const memory = await loadCodingMemory(config.cwd);
        const text = renderMemoryForPrompt(memory, config.cwd);
        return text.trim()
          ? [{ kind: 'memory', source: 'memory', priority: 50, scope: 'workspace', retention: 'compressible', persist: 'memory', memoryType: 'semantic', text }]
          : [];
      },
    },
  ];
}

async function loadGitContext(cwd: string): Promise<string> {
  try {
    const [branch, status] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], { cwd, timeout: 3000 }),
      execFileAsync('git', ['status', '--short'], { cwd, timeout: 3000 }),
    ]);
    return [`branch: ${branch.stdout.trim() || 'detached'}`, 'status:', status.stdout.trim() || '<clean>'].join('\n');
  } catch {
    return '';
  }
}
