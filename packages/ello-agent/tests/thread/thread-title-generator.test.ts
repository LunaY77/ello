import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentModelEvent,
  AgentModelRequest,
  AgentModelResponse,
  ModelAdapter,
} from '../../src/agent/engine/index.js';
import {
  generateThreadTitle,
  renderTitleConversation,
} from '../../src/agent/execution/thread-title-generator.js';
import {
  CodingAgentConfigSchema,
  type CodingAgentConfig,
} from '../../src/config/index.js';
import type { ThreadSnapshot } from '../../src/protocol/v1/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Thread title generator', () => {
  it('使用 title role 生成并规范化会话标题', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-title-generator-'));
    roots.push(root);
    const adapter = new TitleAdapter('  "修复延迟审批响应"  ');
    const title = await generateThreadTitle({
      snapshot: snapshot(root),
      messages: [
        { role: 'user', content: '修复审批按钮无法确认的问题' },
        { role: 'assistant', content: '我会检查请求生命周期。' },
      ],
      config: config(root),
      modelAdapter: adapter,
    });

    expect(title).toBe('修复延迟审批响应');
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.model).toBe('mock/title-model');
    expect(adapter.requests[0]?.system).toContain('session title generator');
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain(
      '修复审批按钮无法确认的问题',
    );
  });

  it('只把最近十二条消息送入标题上下文', () => {
    const rendered = renderTitleConversation(
      Array.from({ length: 14 }, (_, index) => ({
        role: 'user' as const,
        content: `message-${index}`,
      })),
    );

    expect(rendered).not.toContain('message-0\n');
    expect(rendered).not.toContain('message-1\n');
    expect(rendered).toContain('message-2');
    expect(rendered).toContain('message-13');
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

function response(
  request: AgentModelRequest,
  title: string,
): AgentModelResponse {
  return {
    text: title,
    messages: [...request.messages, { role: 'assistant', content: title }],
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

function config(cwd: string): CodingAgentConfig {
  return CodingAgentConfigSchema.parse({
    cwd,
    initial_mode: 'ask-before-changes',
    active_profile: 'main',
    provider: {
      mock: { kind: 'openai-compatible', api_key: 'test-key' },
    },
    models: {
      mock: {
        'title-model': {
          provider: 'mock',
          api_id: 'title-model',
        },
      },
    },
    profile: {
      main: {
        models: {
          primary: 'mock/title-model',
          small: 'mock/title-model',
          compact: 'mock/title-model',
          title: 'mock/title-model',
          review: 'mock/title-model',
        },
      },
    },
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
      profile: 'main',
      model: 'mock/title-model',
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
