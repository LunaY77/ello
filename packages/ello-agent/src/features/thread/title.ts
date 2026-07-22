/**
 * 本文件负责 thread feature 的Thread 标题生成。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { ThreadSnapshot } from '../../protocol/v1/index.js';
import type { AgentMessage, ModelAdapter } from '../agent/engine/index.js';
import {
  createAgentRegistry,
  runInternalAgent,
} from '../agent/subagents/index.js';
import {
  loadCodingAgentConfig,
  type CodingAgentConfig,
} from '../config/index.js';
import { createProviderRegistry } from '../model/index.js';

import { compactionView } from './compact.js';
import type { ThreadStore } from './store.js';

export interface ThreadTitleGenerator {
  /**
   * 在 Thread `title` 模块 中执行 `generate` 完整流程，并在返回前完成其必要副作用。
   *
   * Args:
   * - `snapshot`: `generate` 所需的业务值；函数按声明读取，不补造缺失内容。
   * - `signal`: 调用方拥有的取消信号；触发后当前异步操作必须尽快终止并保留取消原因。
   *
   * Returns:
   * - Promise 在 Thread `title` 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  generate(
    snapshot: ThreadSnapshot,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

/**
 * 构造 Thread `title` 模块 中的 `createThreadTitleGenerator` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `options`: 仅作用于 `createThreadTitleGenerator` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `createThreadTitleGenerator` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Thread `title` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createThreadTitleGenerator(options: {
  readonly store: ThreadStore;
  readonly modelAdapter: ModelAdapter;
}): ThreadTitleGenerator {
  return {
    async generate(snapshot, signal) {
      const [config, records] = await Promise.all([
        loadCodingAgentConfig({
          cwd: snapshot.thread.cwd,
          initial_mode: snapshot.settings.mode,
        }),
        options.store.read(snapshot.thread.id),
      ]);
      return generateThreadTitle({
        snapshot,
        messages: compactionView(records).projectedMessages,
        config,
        modelAdapter: options.modelAdapter,
        signal,
      });
    },
  };
}

/**
 * 在 Thread `title` 模块 中执行 `generateThreadTitle` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `input`: `generateThreadTitle` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - Promise 在 Thread `title` 模块 的异步读取或状态变更完成后兑现为声明结果。
 */
export async function generateThreadTitle(input: {
  readonly snapshot: ThreadSnapshot;
  readonly messages: readonly AgentMessage[];
  readonly config: CodingAgentConfig;
  readonly modelAdapter: ModelAdapter;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  if (input.snapshot.thread.name.trim() !== '' || input.messages.length === 0) {
    return undefined;
  }
  const providerRegistry = createProviderRegistry(input.config);
  const agentRegistry = await createAgentRegistry(input.config);
  const generated = await runInternalAgent({
    definition: agentRegistry.get('title'),
    prompt: renderTitleConversation(input.messages),
    profileName: input.snapshot.settings.profile,
    config: input.config,
    providerRegistry,
    modelAdapter: input.modelAdapter,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const title = normalizeGeneratedTitle(generated);
  return title === '' ? undefined : title;
}

/**
 * 执行 Thread `title` 模块 定义的 `renderTitleConversation` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `renderTitleConversation` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function renderTitleConversation(
  messages: readonly AgentMessage[],
): string {
  return messages
    .slice(-12)
    .map((message) => {
      const text =
        typeof message.content === 'string'
          ? message.content
          : serializeTitleMessageContent(message.content);
      return `### ${message.role}\n${text.slice(0, 1_000)}`;
    })
    .join('\n\n');
}

/**
 * 把结构化模型消息序列化为标题上下文，并拒绝不可表示的内容。
 *
 * Args:
 * - `content`: 已通过 engine 消息契约的结构化 content；函数不修改其数组或对象。
 *
 * Returns:
 * - 返回可直接写入 prompt 的 JSON 文本。
 *
 * Throws:
 * - 内容无法被 JSON 表示时直接抛错。
 */
function serializeTitleMessageContent(
  content: Exclude<AgentMessage['content'], string>,
): string {
  const serialized = JSON.stringify(content);
  if (serialized === undefined) {
    throw new Error('Thread title message content is not JSON serializable.');
  }
  return serialized;
}

/**
 * 校验 Thread `title` 模块 的输入并返回已满足领域约束的值。
 *
 * Args:
 * - `value`: 要由 `normalizeGeneratedTitle` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `normalizeGeneratedTitle` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function normalizeGeneratedTitle(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .slice(0, 80);
}
