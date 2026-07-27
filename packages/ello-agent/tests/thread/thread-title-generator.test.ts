/**
 * 本文件验证 thread-title-generator 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentModelEvent,
  AgentModelRequest,
  AgentModelResponse,
  ModelAdapter,
} from '../../src/features/agent/engine/index.js';
import {
  CodingAgentConfigSchema,
  type CodingAgentConfig,
} from '../../src/features/config/index.js';
import {
  generateThreadTitle,
  renderTitleMessage,
} from '../../src/features/thread/title.js';
import type { ThreadSnapshot } from '../../src/protocol/v1/index.js';

const roots: string[] = [];
let previousTestApiKey: string | undefined;

beforeEach(() => {
  previousTestApiKey = process.env.TEST_API_KEY;
  process.env.TEST_API_KEY = 'test-key';
});

afterEach(async () => {
  if (previousTestApiKey === undefined) delete process.env.TEST_API_KEY;
  else process.env.TEST_API_KEY = previousTestApiKey;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Thread title generator', () => {
  it('uses the title agent auxiliary model to generate and normalize a title', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-title-generator-'));
    roots.push(root);
    const adapter = new TitleAdapter('  "修复延迟审批响应"  ');
    const title = await generateThreadTitle({
      snapshot: snapshot(root),
      message: { role: 'user', content: '修复审批按钮无法确认的问题' },
      config: config(root, true),
      modelAdapter: adapter,
    });

    expect(title).toBe('修复延迟审批响应');
    expect(adapter.requests).toHaveLength(1);
    const request = adapter.requests[0];
    if (request === undefined) {
      throw new Error('Title adapter did not receive the expected request.');
    }
    if (typeof request.model === 'string') {
      throw new Error('Title model was not resolved to a LanguageModel.');
    }
    expect(request.model.modelId).toBe('title-model');
    expect(request.instructions).toContain('session title generator');
    expect(JSON.stringify(request.messages)).toContain(
      '修复审批按钮无法确认的问题',
    );
  });

  it('关闭模型生成时直接使用第一条用户消息', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-title-generator-'));
    roots.push(root);
    const adapter = new TitleAdapter('不应调用模型');
    const title = await generateThreadTitle({
      snapshot: snapshot(root),
      message: {
        role: 'user',
        content: '  修复审批按钮\n无法确认的问题  ',
      },
      config: config(root, false),
      modelAdapter: adapter,
    });

    expect(title).toBe('修复审批按钮 无法确认的问题');
    expect(adapter.requests).toHaveLength(0);
  });

  it('标题模型输入只包含首条用户消息', () => {
    expect(renderTitleMessage({ role: 'user', content: 'first message' })).toBe(
      '### user\nfirst message',
    );
    expect(() =>
      renderTitleMessage({ role: 'assistant', content: 'not user input' }),
    ).toThrow('must be a user message');
  });

  it('Server 关闭中止标题模型时正常结束', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-title-generator-'));
    roots.push(root);
    const adapter = new BlockingTitleAdapter();
    const controller = new AbortController();
    const task = generateThreadTitle({
      snapshot: snapshot(root),
      message: { role: 'user', content: '修复审批按钮无法确认的问题' },
      config: config(root, true),
      modelAdapter: adapter,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(adapter.started).toBe(true));
    controller.abort('thread runtime closing');

    await expect(task).resolves.toBeUndefined();
  });
});

class TitleAdapter implements ModelAdapter {
  readonly requests: AgentModelRequest[] = [];

  constructor(private readonly title: string) {}

  generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    this.requests.push(request);
    return Promise.resolve(response(request, this.title));
  }

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
    const result = await this.generate(request);
    yield { type: 'text-delta', text: this.title };
    yield { type: 'final', response: result };
  }
}

class BlockingTitleAdapter implements ModelAdapter {
  started = false;

  generate(_request: AgentModelRequest): Promise<AgentModelResponse> {
    throw new Error('Blocking title adapter only supports streaming.');
  }

  stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
    const signal = request.signal;
    if (signal === undefined) {
      throw new Error('Blocking title request requires an abort signal.');
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          this.started = true;
          return new Promise<IteratorResult<AgentModelEvent>>(
            (_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('Title request aborted.')),
                { once: true },
              );
            },
          );
        },
      }),
    };
  }
}

function response(
  request: AgentModelRequest,
  title: string,
): AgentModelResponse {
  return {
    text: title,
    messages: [...request.messages, { role: 'assistant', content: title }],
    newMessages: [{ role: 'assistant', content: title }],
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
    },
    finishReason: 'stop',
    provider: { test: true },
  };
}

function config(cwd: string, titleGeneration: boolean): CodingAgentConfig {
  return CodingAgentConfigSchema.parse({
    cwd,
    initial_mode: 'ask-before-changes',
    title_generation: titleGeneration,
    models: {
      'primary-model': {
        protocol: 'openai-compatible',
        endpoint: 'chat',
        api_model: 'primary-model',
        base_url: 'https://api.example.test/v1',
        api_key_env: 'TEST_API_KEY',
        context_window: 128_000,
        max_output_tokens: 16_000,
        reasoning_effort: 'medium',
      },
      'title-model': {
        protocol: 'openai-compatible',
        endpoint: 'chat',
        api_model: 'title-model',
        base_url: 'https://api.example.test/v1',
        api_key_env: 'TEST_API_KEY',
        context_window: 128_000,
        max_output_tokens: 16_000,
        reasoning_effort: 'low',
      },
    },
    primary_model: 'primary-model',
    auxiliary_model: 'title-model',
  });
}

function snapshot(cwd: string): ThreadSnapshot {
  const createdAt = '2026-07-19T00:00:00.000Z';
  return {
    thread: {
      id: 'thr_title',
      rootId: 'thr_title',
      cwd,
      name: '',
      preview: '修复审批按钮无法确认的问题',
      status: 'idle',
      archived: false,
      createdAt,
      updatedAt: createdAt,
    },
    settings: {
      mode: 'ask-before-changes',
      agent: 'build',
    },
    turns: [],
    pendingServerRequests: [],
    goal: null,
    plan: null,
    usage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
    },
    seq: 1,
  };
}
