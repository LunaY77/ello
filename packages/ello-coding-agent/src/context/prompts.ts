import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nunjucks from 'nunjucks';

import type { CodingAgentConfig } from '../config/index.js';

import {
  loadInstructionSources,
  loadProjectInstructions,
} from './instructions.js';
import {
  estimateTextTokens,
  loadContextBundle,
  type ContextBundle,
  type ContextEvent,
  type ContextSourceLoadResult,
} from './source-registry.js';

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
  return async () => {
    const profile =
      runtime.profile ??
      (config.context.system_prompt_profile !== 'coding'
        ? config.context.system_prompt_profile
        : config.systemPromptProfile) ??
      config.systemPromptProfile;
    const contextDeps: ContextDeps = {
      ...(runtime.activeSkills !== undefined
        ? { activeSkills: runtime.activeSkills }
        : {}),
      ...(runtime.onContextEvent !== undefined
        ? { onContextEvent: runtime.onContextEvent }
        : {}),
    };
    const context = await buildContextBundle(config, contextDeps);
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
  return loadContextBundle(
    [
      () => loadEnvironmentSource(config),
      () => loadInstructionSources(config),
      () => loadActiveSkillsSource(deps),
    ],
    deps.onContextEvent,
  );
}

function loadPromptTemplate(profile: string): string {
  const promptPath = path.join(promptDir(), `${profile}.md`);
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

async function loadEnvironmentSource(
  config: CodingAgentConfig,
): Promise<ContextSourceLoadResult> {
  const allowed =
    config.allowedPaths.length > 0
      ? config.allowedPaths.join('\n')
      : config.cwd;
  const approval = approvalGuidance(config.approvalMode);
  const content = [
    '<file-system>',
    `  <working-directory>${config.cwd}</working-directory>`,
    `  <allowed-paths>\n${indent(allowed)}\n  </allowed-paths>`,
    '</file-system>',
    '<shell>',
    `  <working-directory>${config.cwd}</working-directory>`,
    `  <allowed-paths>\n${indent(allowed)}\n  </allowed-paths>`,
    '</shell>',
    '<approval>',
    `  <mode>${config.approvalMode}</mode>`,
    `  <guidance>${approval}</guidance>`,
    '</approval>',
    'Stay within the allowed paths unless the user explicitly broadens the scope.',
  ].join('\n');
  return {
    sources: [
      {
        id: 'environment:runtime',
        type: 'environment',
        title: 'Runtime environment',
        priority: 60,
        content,
        origin: config.cwd,
        tokensEstimate: estimateTextTokens(content),
      },
    ],
  };
}

async function loadActiveSkillsSource(
  deps: ContextDeps,
): Promise<ContextSourceLoadResult> {
  const skills = [...(await (deps.activeSkills?.() ?? []))];
  const content = skills.map((skill) => `- ${skill}`).join('\n');
  return {
    sources:
      content.length > 0
        ? [
            {
              id: 'skills:active',
              type: 'skill',
              title: 'Active skills',
              priority: 300,
              content,
              tokensEstimate: estimateTextTokens(content),
            },
          ]
        : [],
  };
}

function approvalGuidance(mode: CodingAgentConfig['approvalMode']): string {
  const guidance: Record<CodingAgentConfig['approvalMode'], string> = {
    default:
      'File edits and command execution require explicit user approval each time.',
    plan: 'Plan first; file edits and command execution require explicit user approval.',
    'accept-edits':
      'File edits are auto-approved; higher-risk actions still need approval.',
    bypass:
      'All approvals are bypassed; act carefully because changes apply without a prompt.',
    'dont-ask':
      'Approvals are not prompted; actions are decided silently by configured rules.',
  };
  return guidance[mode];
}

function indent(value: string): string {
  return value
    .split('\n')
    .map((line) => `    <path>${line}</path>`)
    .join('\n');
}
