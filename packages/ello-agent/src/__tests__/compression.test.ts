import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentContext,
  LocalEnvironment,
  ModelConfig,
  buildCompactedMessages,
  createCompactFilter,
  estimateMessagesTokens,
  estimateTokens,
  extractFileOperations,
  findCutPoint,
  generateSummary,
  needCompact,
  trimHistory,
  type SummaryAgent,
} from '../index.js';

function user(content: ModelMessage['content']): ModelMessage {
  return { role: 'user', content };
}

function assistant(content: ModelMessage['content']): ModelMessage {
  return { role: 'assistant', content };
}

function toolResult(toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName,
        output: { type: 'text', value },
      },
    ],
  };
}

function context(input: { contextWindow?: number | null } = {}): AgentContext {
  return new AgentContext({
    env: new LocalEnvironment(),
    modelConfig: new ModelConfig({
      contextWindow:
        input.contextWindow === undefined ? 1_000 : input.contextWindow,
      compactThreshold: 0.9,
    }),
  });
}

describe('trimHistory', () => {
  it('truncates long tool return content', () => {
    const result = trimHistory([toolResult('test', 'x'.repeat(1_000))]);

    expect(result.truncatedToolReturnCount).toBe(1);
    const message = result.messages[0]!;
    expect(message.role).toBe('tool');
    expect(JSON.stringify(message.content)).toContain('chars truncated');
  });

  it('strips injected context tags from user text', () => {
    const result = trimHistory([
      user('Hello <runtime-context>some data</runtime-context> world'),
    ]);

    expect(result.strippedInjectedContextCount).toBe(1);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: 'Hello  world',
    });
  });

  it('removes user message when it only contains injected context', () => {
    const result = trimHistory([
      user('<runtime-context>only context here</runtime-context>'),
    ]);

    expect(result.strippedInjectedContextCount).toBe(1);
    expect(result.messages).toEqual([]);
  });

  it('preserves injected context in the last user turn', () => {
    const result = trimHistory(
      [user('<runtime-context>data</runtime-context> hello')],
      { preserveLastTurn: true },
    );

    expect(result.strippedInjectedContextCount).toBe(0);
    expect(JSON.stringify(result.messages)).toContain('<runtime-context>');
  });

  it('replaces image parts with text placeholders', () => {
    const result = trimHistory([
      user([
        { type: 'text', text: 'before' },
        { type: 'image', image: new URL('https://example.com/image.png') },
        { type: 'text', text: 'after' },
      ]),
    ]);

    expect(result.strippedMediaCount).toBe(1);
    const message = result.messages[0]!;
    expect(message.role).toBe('user');
    expect(JSON.stringify(message.content)).toContain('image:');
  });
});

describe('cut point', () => {
  it('estimates tokens from message text', () => {
    expect(estimateTokens(user('hello world'))).toBe(
      Math.floor('hello world'.length / 4),
    );
    expect(estimateTokens(assistant('a'.repeat(400)))).toBe(100);
  });

  it('estimates total tokens for multiple messages', () => {
    expect(
      estimateMessagesTokens([
        user('a'.repeat(80)),
        assistant('b'.repeat(120)),
      ]),
    ).toBe(50);
  });

  it('finds a cut point near a user turn boundary', () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 20; i += 1) {
      messages.push(user(`question ${i} `.repeat(50)));
      messages.push(assistant(`answer ${i} `.repeat(50)));
    }

    const result = findCutPoint(messages, 500);

    expect(result).not.toBeNull();
    expect(result!.firstKeptIndex).toBeGreaterThan(0);
    expect(result!.firstKeptIndex).toBeLessThan(messages.length);
  });
});

describe('compact', () => {
  it('checks compact threshold from latest assistant usage', () => {
    const msg = {
      ...assistant('hi'),
      usage: { totalTokens: 900 },
    } as ModelMessage;

    expect(needCompact(context({ contextWindow: 1_000 }), [msg])).toBe(true);
  });

  it('does not compact without context window', () => {
    const msg = {
      ...assistant('hi'),
      usage: { totalTokens: 900 },
    } as ModelMessage;

    expect(needCompact(context({ contextWindow: null }), [msg])).toBe(false);
  });

  it('builds compacted messages with summary and kept messages', () => {
    const kept = [user('recent question'), assistant('recent answer')];
    const messages = buildCompactedMessages('Summary', 'Original', kept);

    expect(messages[0]!.role).toBe('system');
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Summary' });
    expect(messages.at(-2)).toBe(kept[0]);
    expect(messages.at(-1)).toBe(kept[1]);
  });

  it('creates a compact filter that emits compact event', async () => {
    const agent: SummaryAgent = {
      run: vi.fn(async () => 'Generated summary'),
    };
    const ctx = context({ contextWindow: 1_000 });
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 20; i += 1) {
      messages.push(user(`question ${i} `.repeat(50)));
      messages.push(assistant(`answer ${i} `.repeat(50)));
    }
    messages.push({
      ...assistant('latest'),
      usage: { totalTokens: 950 },
    } as ModelMessage);

    const filter = createCompactFilter();
    const compacted = await filter({ deps: ctx, agent }, messages);

    expect(compacted.length).toBeLessThan(messages.length);
    expect(JSON.stringify(compacted)).toContain('Generated summary');
    expect(ctx.events).toHaveLength(1);
  });
});

describe('summarize', () => {
  it('extracts file operation hints from tool results', () => {
    const result = extractFileOperations([
      toolResult('read_file', 'src/index.ts content'),
      toolResult('edit', 'updated src/index.ts'),
    ]);

    expect(result.readFiles[0]).toContain('read_file');
    expect(result.modifiedFiles[0]).toContain('edit');
  });

  it('passes trimmed messages and prompt to summary agent', async () => {
    const agent: SummaryAgent = {
      run: vi.fn(async () => 'summary'),
    };
    const result = await generateSummary(
      [user('<runtime-context>ctx</runtime-context>keep')],
      agent,
      context(),
      { previousSummary: 'old summary', customInstructions: 'extra rule' },
    );

    expect(result).toBe('summary');
    expect(agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('old summary'),
        messages: [{ role: 'user', content: 'keep' }],
      }),
    );
  });
});
