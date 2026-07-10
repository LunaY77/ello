import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nunjucks from 'nunjucks';

import type { CodingAgentConfig } from '../config/index.js';

import {
  ContextSnapshot,
  type ContextSnapshotDeps,
} from './context-snapshot.js';
import { loadProjectInstructions } from './instructions.js';
import type { ContextBundle, ContextEvent } from './source-registry.js';

export { loadProjectInstructions };

/** prompt 模板渲染时需要的动态 context 依赖。 */
export interface ContextDeps {
  /** 当前激活技能名列表的读取器。 */
  readonly activeSkills?: () => Promise<readonly string[]> | readonly string[];
  /** context pipeline 事件接收器，供 JSONL/TUI 观察 source 加载。 */
  readonly onContextEvent?: (event: ContextEvent) => void;
}

export interface CodingSystemPromptRuntime {
  readonly model: string;
  readonly profile?: string;
  readonly activeSkills?: ContextDeps['activeSkills'];
  readonly onContextEvent?: (event: ContextEvent) => void;
}

/** 渲染 coding-agent 的 Markdown prompt 模板。 */
export function renderPromptTemplate(
  profile: string,
  variables: Record<string, unknown> = {},
): string {
  return nunjucks.renderString(loadPromptTemplate(profile), {
    agent_name: 'ello',
    ...variables,
  });
}

/**
 * 构造 coding-agent 的基础系统提示词预览。
 *
 * 运行时使用 {@link createCodingSystemPromptSection}，会先加载 context bundle，
 * 再把它作为 Nunjucks 变量渲染进同一个 Markdown 模板。
 */
export function buildCodingSystemPrompt(
  config: CodingAgentConfig,
  runtime: CodingSystemPromptRuntime,
): string {
  const profile =
    runtime.profile ??
    (config.context.system_prompt_profile !== 'coding'
      ? config.context.system_prompt_profile
      : config.systemPromptProfile) ??
    config.systemPromptProfile;
  return renderPromptTemplate(profile, { model: runtime.model });
}

/** 每轮动态渲染完整 base prompt：稳定规则 + context bundle 都在 Markdown 模板里装配。 */
export function createCodingSystemPromptSection(
  config: CodingAgentConfig,
  runtime: CodingSystemPromptRuntime,
) {
  return async (run: {
    readonly state: { readonly budget: Record<string, unknown> };
  }) => {
    const profile = resolvePromptProfile(config, runtime);
    const contextDeps: ContextSnapshotDeps = {
      ...(runtime.activeSkills !== undefined
        ? { activeSkills: runtime.activeSkills }
        : {}),
      ...(runtime.onContextEvent !== undefined
        ? { onContextEvent: runtime.onContextEvent }
        : {}),
    };
    const snapshotKey = 'coding-agent.context-snapshot';
    const current = run.state.budget[snapshotKey];
    const snapshot =
      current === undefined
        ? new ContextSnapshot(
            config,
            contextDeps,
            profile,
            createHash('sha256')
              .update(loadPromptTemplate(profile))
              .digest('hex'),
          )
        : requireContextSnapshot(current);
    run.state.budget[snapshotKey] = snapshot;
    const context = await snapshot.render();
    return renderPromptTemplate(profile, {
      model: runtime.model,
      context_bundle: context.system,
      context_sources: context.sources,
    });
  };
}

/**
 * 构造 coding-agent 的动态 context bundle。
 *
 * 这里保留 source registry 的加载、去重、排序和诊断能力；最终注入位置由
 * `coding.md` 的 Nunjucks 模板决定，而不是再额外拼一个 system section。
 */
export function buildContextBundle(
  config: CodingAgentConfig,
  deps: ContextDeps = {},
): Promise<ContextBundle> {
  const profile = resolvePromptProfile(config, {});
  return new ContextSnapshot(
    config,
    deps,
    profile,
    createHash('sha256').update(loadPromptTemplate(profile)).digest('hex'),
  ).render();
}

function loadPromptTemplate(profile: string): string {
  if (profile === 'coding') {
    return [
      readPromptFile('core-behavior.md'),
      readPromptFile('primary-agent.md'),
    ].join('\n\n');
  }
  if (profile === 'subagent') {
    return [
      readPromptFile('core-behavior.md'),
      readPromptFile('subagent.md'),
    ].join('\n\n');
  }
  return readPromptFile(`${profile}.md`);
}

function readPromptFile(fileName: string): string {
  const promptPath = path.join(promptDir(), fileName);
  try {
    return readFileSync(promptPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to load prompt template: ${promptPath}`, {
      cause: error,
    });
  }
}

function promptDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
}

function resolvePromptProfile(
  config: CodingAgentConfig,
  runtime: Pick<CodingSystemPromptRuntime, 'profile'>,
): string {
  return (
    runtime.profile ??
    (config.context.system_prompt_profile !== 'coding'
      ? config.context.system_prompt_profile
      : config.systemPromptProfile) ??
    config.systemPromptProfile
  );
}

function requireContextSnapshot(value: unknown): ContextSnapshot {
  if (!(value instanceof ContextSnapshot)) {
    throw new Error('Invalid coding-agent context snapshot state.');
  }
  return value;
}
