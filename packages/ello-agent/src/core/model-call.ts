import { randomUUID } from 'node:crypto';

import { ModelAdapterProtocolError } from '../public/errors.js';
import type {
  AgentModelRequest,
  AgentModelResponse,
  ModelInput,
} from '../public/types.js';

import type { RunSession } from './run-session.js';

/**
 * 单次模型调用的封装。
 *
 * 把内核构建好的 {@link ModelInput} 组装成 provider 无关的
 * {@link AgentModelRequest}，再交给模型适配器去执行。本模块同时负责：
 * - 把适配器流出的 `text-delta` 增量转译成 `message.delta` 事件向外推送；
 * - 在取消信号触发或适配器抛出 abort 类错误时，统一收敛为「中断」结果，
 *   而非把异常继续向上抛。
 * 它只关心「一轮」模型补全，回合循环、工具执行等由上层负责。
 */

/** 单次模型调用的结果。 */
export interface ModelCallResult {
  /** 模型最终响应；被中断时缺省。 */
  readonly response?: AgentModelResponse;
  /** 当调用因取消信号而提前结束时取 `'interrupted'`。 */
  readonly stopReason?: 'interrupted';
}

/**
 * 执行一次模型调用并把增量文本转成事件流。
 *
 * 流程：
 * 1. 进入前先检查取消信号，已取消则直接标记中断返回；
 * 2. 生成消息 id 并发出 `message.started`；
 * 3. 迭代适配器的流式输出：`text-delta` 转为 `message.delta` 推送，
 *    其余事件携带最终响应；
 * 4. adapter 必须恰好给出一个 final，违反协议直接失败；
 * 5. 捕获 abort 类错误统一收敛为中断结果，其他错误继续上抛。
 */
export async function callModel(
  run: RunSession,
  input: ModelInput,
): Promise<ModelCallResult> {
  // 调用前就已收到取消信号：无需起请求，直接标记中断。
  if (run.signal.aborted) {
    run.markInterrupted();
    return { stopReason: 'interrupted' };
  }

  // 为本条助手消息分配稳定 id，后续所有增量事件都挂在它上面。
  const messageId = randomUUID();
  await run.events.emit({
    type: 'message.started',
    messageId,
    role: 'assistant',
  });

  const request = createModelRequest(run, input);
  const startedAt = performance.now();
  let finalResponse: AgentModelResponse | null = null;
  try {
    for await (const event of run.modelAdapter.stream(request)) {
      if (finalResponse !== null) {
        throw new ModelAdapterProtocolError(
          event.type === 'final'
            ? 'Model adapter emitted more than one final event.'
            : 'Model adapter emitted an event after the final event.',
        );
      }
      if (event.type === 'text-delta') {
        // 文本增量：实时转发为 message.delta，驱动上层增量渲染。
        await run.events.emit({
          type: 'message.delta',
          messageId,
          text: event.text,
        });
      } else {
        finalResponse = event.response;
      }
    }
    if (finalResponse === null) {
      throw new ModelAdapterProtocolError(
        'Model adapter stream ended without a final event.',
      );
    }
    const diagnostics = input.diagnostics;
    if (diagnostics === undefined) {
      throw new Error('Model input diagnostics are required for model calls.');
    }
    const identity = modelIdentity(run.config.model);
    await run.events.modelCallCompleted({
      runId: run.runId,
      turnIndex: run.state.turn,
      provider: identity.provider,
      model: identity.model,
      finishReason: finalResponse.finishReason,
      usage: finalResponse.usage,
      durationMs: performance.now() - startedAt,
      systemFingerprint: diagnostics.systemFingerprint,
      toolsetFingerprint: diagnostics.toolsetFingerprint,
      messagePrefixFingerprint: diagnostics.messagePrefixFingerprint,
      compactionBoundary: diagnostics.compactionBoundary,
    });
    return { response: finalResponse };
  } catch (error) {
    // 取消信号或 abort 类错误统一收敛为中断，不向上抛异常。
    if (run.signal.aborted || isAbortError(error)) {
      run.markInterrupted();
      return { stopReason: 'interrupted' };
    }
    throw error;
  }
}

function modelIdentity(model: AgentModelRequest['model']): {
  readonly provider: string;
  readonly model: string;
} {
  if (typeof model === 'string') {
    const separator = model.includes('/') ? '/' : ':';
    const [provider, ...modelParts] = model.split(separator);
    if (provider === undefined || provider === '' || modelParts.length === 0) {
      throw new Error(`Invalid string model identity: ${model}`);
    }
    return { provider, model: modelParts.join(separator) };
  }
  if (
    typeof model.provider !== 'string' ||
    model.provider === '' ||
    typeof model.modelId !== 'string' ||
    model.modelId === ''
  ) {
    throw new Error('Language model must expose provider and modelId.');
  }
  return { provider: model.provider, model: model.modelId };
}

/**
 * 把内核侧的 {@link ModelInput} 组装成 provider 无关的请求对象。
 *
 * 仅当对应字段存在时才写入，避免给适配器传入 `undefined` 噪声；
 * `modelSettings` 以 `run.config` 为底、`run.options` 覆盖在上。
 */
function createModelRequest(
  run: RunSession,
  input: ModelInput,
): AgentModelRequest {
  return {
    runId: run.runId,
    model: run.config.model,
    ...(input.system !== undefined ? { system: input.system } : {}),
    messages: input.messages,
    tools: input.tools,
    ...(input.activeTools !== undefined
      ? { activeTools: input.activeTools }
      : {}),
    ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
    ...(input.providerOptions !== undefined
      ? { providerOptions: input.providerOptions }
      : {}),
    modelSettings: {
      ...(run.config.modelSettings ?? {}),
      ...(run.options.modelSettings ?? {}),
    },
    signal: run.signal,
  };
}

/** 判断错误是否为取消/超时类（`AbortError` / `TimeoutError`）。 */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
