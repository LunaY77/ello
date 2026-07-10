import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentRunContext } from '@ello/agent';
import nunjucks from 'nunjucks';

import type { CodingAgentConfig } from '../config/index.js';

import { wrapDynamicSystemContent } from './cache-layout.js';
import {
  ContextSnapshot,
  type ContextSnapshotDeps,
} from './context-snapshot.js';
import type { ContextBundle, ContextEvent } from './source-registry.js';

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
  const snapshots = new WeakMap<AgentRunContext, ContextSnapshot>();
  return async (run: AgentRunContext) => {
    const profile = resolvePromptProfile(config, runtime);
    const contextDeps: ContextSnapshotDeps = {
      ...(runtime.activeSkills !== undefined
        ? { activeSkills: runtime.activeSkills }
        : {}),
      ...(runtime.onContextEvent !== undefined
        ? { onContextEvent: runtime.onContextEvent }
        : {}),
    };
    let snapshot = snapshots.get(run);
    if (snapshot === undefined) {
      snapshot = new ContextSnapshot(
        config,
        contextDeps,
        profile,
        createHash('sha256').update(loadPromptTemplate(profile)).digest('hex'),
      );
      snapshots.set(run, snapshot);
    }
    const context = await snapshot.render();
    const stable = [
      renderPromptTemplate(profile, { model: runtime.model }),
      context.stableSystem,
    ]
      .filter(Boolean)
      .join('\n\n');
    return context.dynamicSystem === ''
      ? stable
      : `${stable}\n\n${wrapDynamicSystemContent(context.dynamicSystem)}`;
  };
}

/**
 * 构造 coding-agent 的动态 context bundle。
 *
 * 这里保留 source registry 的加载、去重、排序和诊断能力；调用方可独立读取
 * bundle，运行时则由稳定 prompt section 统一装配。
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
