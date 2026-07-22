/**
 * 本文件负责 agent feature 的“prompts”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nunjucks from 'nunjucks';

import type { CodingAgentConfig } from '../../config/index.js';
import type { AgentMemoryContextLoader } from '../contracts.js';
import {
  wrapDynamicSystemContent,
  type AgentInput,
  type AgentRunContext,
} from '../engine/index.js';

import {
  ContextSnapshot,
  type ContextSnapshotDeps,
} from './context-snapshot.js';
import type { ContextBundle, ContextEvent } from './source-registry.js';

/** prompt 模板渲染时需要的动态 context 依赖。 */
export interface ContextDeps {
  /**
   * context pipeline 事件接收器，供 JSONL/TUI 观察 source 加载。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   *
   * Returns:
   * - 产品 Agent `prompts` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  readonly onContextEvent?: (event: ContextEvent) => void;
  readonly memoryIndexLoader?: AgentMemoryContextLoader;
}

export interface CodingSystemPromptRuntime {
  readonly model: string;
  readonly profile?: string;
  /**
   * 处理 产品 Agent `prompts` 模块 的 `onContextEvent` 事件，并保持生产顺序与失败传播语义。
   *
   * Args:
   * - `event`: 上游按顺序产生的单个事件；当前边界只处理一次，失败直接向调用方传播。
   *
   * Returns:
   * - 产品 Agent `prompts` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  readonly onContextEvent?: (event: ContextEvent) => void;
  readonly memory?: {
    readonly loader: AgentMemoryContextLoader;
    readonly roots: {
      readonly private: string;
      readonly team: string;
    };
  };
}

/** 已读取模板的进程内快照；运行中的 CLI 不应受并发构建切换 dist 目录影响。 */
const promptFileCache = new Map<string, string>();

/**
 * 渲染 coding-agent 的 Markdown prompt 模板。
 *
 * Args:
 * - `profile`: `renderPromptTemplate` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `variables`: `renderPromptTemplate` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - 返回 `renderPromptTemplate` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
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
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 * - `runtime`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 *
 * Returns:
 * - 返回 `buildCodingSystemPrompt` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent `prompts` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function buildCodingSystemPrompt(
  config: CodingAgentConfig,
  runtime: CodingSystemPromptRuntime,
): string {
  const profile =
    runtime.profile ??
    (config.context.system_prompt_profile !== 'coding'
      ? config.context.system_prompt_profile
      : config.system_prompt_profile) ??
    config.system_prompt_profile;
  return renderPromptTemplate(profile, { model: runtime.model });
}

/**
 * 每轮动态渲染完整 base prompt：稳定规则 + context bundle 都在 Markdown 模板里装配。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 * - `runtime`: 调用方拥有的运行上下文；本函数仅在调用生命周期内读取或调用其公开能力。
 *
 * Returns:
 * - 返回 `createCodingSystemPromptSection` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent `prompts` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createCodingSystemPromptSection(
  config: CodingAgentConfig,
  runtime: CodingSystemPromptRuntime,
) {
  const snapshots = new WeakMap<AgentRunContext, ContextSnapshot>();
  return async (run: AgentRunContext) => {
    const profile = resolvePromptProfile(config, runtime);
    const memory = runtime.memory;
    const contextDeps: ContextSnapshotDeps = {
      ...(runtime.onContextEvent !== undefined
        ? { onContextEvent: runtime.onContextEvent }
        : {}),
      ...(memory !== undefined ? { memoryIndexLoader: memory.loader } : {}),
    };
    const includeMemory =
      config.context.memory.enabled &&
      memory !== undefined &&
      !shouldIgnoreMemory(run.input);
    let snapshot = snapshots.get(run);
    if (snapshot === undefined) {
      snapshot = new ContextSnapshot(
        config,
        contextDeps,
        profile,
        createHash('sha256').update(loadPromptTemplate(profile)).digest('hex'),
        includeMemory,
      );
      snapshots.set(run, snapshot);
    }
    const context = await snapshot.render();
    const stable = [
      renderPromptTemplate(profile, { model: runtime.model }),
      includeMemory && memory !== undefined
        ? renderPromptTemplate('memory', {
            private_memory_dir: memory.roots.private,
            team_memory_dir: memory.roots.team,
          })
        : '',
      context.stableSystem,
    ]
      .filter(Boolean)
      .join('\n\n');
    return context.dynamicSystem === ''
      ? stable
      : `${stable}\n\n${wrapDynamicSystemContent(context.dynamicSystem)}`;
  };
}

function shouldIgnoreMemory(input: AgentInput): boolean {
  const text = inputText(input).toLocaleLowerCase();
  return /\b(ignore|do not use|don't use|not use)\s+(the\s+)?memor(?:y|ies)\b/u.test(
    text,
  );
}

function inputText(input: AgentInput): string {
  if (typeof input === 'string') {
    return input;
  }
  const messages = Array.isArray(input) ? input : input.messages;
  const userMessages: string[] = [];
  if (messages !== undefined) {
    for (const message of messages) {
      if (message.role === 'user') {
        userMessages.push(
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content),
        );
      }
    }
  }
  if (!Array.isArray(input) && input.prompt !== undefined) {
    userMessages.push(input.prompt);
  }
  return userMessages.join('\n');
}

/**
 * 构造 coding-agent 的动态 context bundle。
 *
 * 这里保留 source registry 的加载、去重、排序和诊断能力；调用方可独立读取
 * bundle，运行时则由稳定 prompt section 统一装配。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 * - `deps`: `buildContextBundle` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - Promise 在 产品 Agent `prompts` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 产品 Agent `prompts` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
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
    config.context.memory.enabled && deps.memoryIndexLoader !== undefined,
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
  const cached = promptFileCache.get(fileName);
  if (cached !== undefined) {
    return cached;
  }
  const promptPath = path.join(promptDir(), fileName);
  try {
    const template = readFileSync(promptPath, 'utf8');
    promptFileCache.set(fileName, template);
    return template;
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
      : config.system_prompt_profile) ??
    config.system_prompt_profile
  );
}
