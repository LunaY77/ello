/**
 * 本文件负责 agent feature 的“prompts”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash } from 'node:crypto';
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
import type { ContextEvent } from './source-registry.js';

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

const promptEnv = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(promptDir()),
  { autoescape: false },
);

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
  return promptEnv.render(entryTemplate(profile), {
    agent_name: 'ello',
    ...variables,
  });
}

/**
 * 渲染 Markdown agent definition 的正文，并复用系统提示词的受限 include 根目录。
 *
 * Args:
 * - `body`: 已从 definition 文件拆出的 Markdown 正文。
 *
 * Returns:
 * - 返回 include 和变量已经展开的 agent 指令正文。
 *
 * Throws:
 * - 模板语法无效或 include 不在 prompts 根目录时直接抛错。
 */
export function renderAgentPrompt(body: string): string {
  return promptEnv.renderString(body, { agent_name: 'ello' });
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
  const render = createCodingSystemPromptRenderer(config, runtime);
  return (run: AgentRunContext) => render(run.input, run);
}

/**
 * 按产品运行时的真实装配链路渲染一次 coding system prompt，供本地诊断命令使用。
 *
 * Args:
 * - `config`: 已解析的当前配置；决定 profile、instructions、memory 与运行边界。
 * - `runtime`: 当前模型与可选 Memory loader；语义与生产 Agent 装配一致。
 * - `input`: 用于判断本轮是否显式忽略 Memory 的用户输入。
 *
 * Returns:
 * - Promise 兑现为 coding Agent 的完整稳定规则与 context source 文本。
 *
 * Throws:
 * - Prompt 模板、instruction source 或 Memory index 加载失败时直接拒绝。
 */
export function renderCodingSystemPrompt(
  config: CodingAgentConfig,
  runtime: CodingSystemPromptRuntime,
  input: AgentInput,
): Promise<string> {
  return createCodingSystemPromptRenderer(config, runtime)(input);
}

function createCodingSystemPromptRenderer(
  config: CodingAgentConfig,
  runtime: CodingSystemPromptRuntime,
): (input: AgentInput, snapshotOwner?: object) => Promise<string> {
  const profile = resolvePromptProfile(config, runtime);
  const stablePrompt = renderPromptTemplate(profile, {
    model: runtime.model,
    subagents_enabled: config.subagents.enabled,
  });
  const basePromptHash = createHash('sha256')
    .update(stablePrompt)
    .digest('hex');
  const memory = runtime.memory;
  const contextDeps: ContextSnapshotDeps = {
    ...(runtime.onContextEvent !== undefined
      ? { onContextEvent: runtime.onContextEvent }
      : {}),
    ...(memory !== undefined ? { memoryIndexLoader: memory.loader } : {}),
  };
  const snapshots = new WeakMap<object, ContextSnapshot>();
  return async (input: AgentInput, snapshotOwner?: object) => {
    const includeMemory =
      config.context.memory.enabled &&
      memory !== undefined &&
      !shouldIgnoreMemory(input);
    let snapshot =
      snapshotOwner === undefined ? undefined : snapshots.get(snapshotOwner);
    if (snapshot === undefined) {
      snapshot = new ContextSnapshot(
        config,
        contextDeps,
        profile,
        basePromptHash,
        includeMemory,
      );
      if (snapshotOwner !== undefined) snapshots.set(snapshotOwner, snapshot);
    }
    const context = await snapshot.render();
    const stable = [
      stablePrompt,
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

function entryTemplate(profile: string): string {
  return `${['rapid', 'thorough'].includes(profile) ? `primary/${profile}` : profile}.md`;
}

function promptDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
}

function resolvePromptProfile(
  config: CodingAgentConfig,
  runtime: Pick<CodingSystemPromptRuntime, 'profile'>,
): string {
  return runtime.profile ?? config.context.prompt_mode;
}
