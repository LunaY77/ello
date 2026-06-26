import { describe, expect, it } from 'vitest';

import { UsageSnapshot, addUsage, coerceRunUsage } from '../index.js';

describe('usage helpers', () => {
  it('coerces camelCase, snake_case and callable usage', () => {
    expect(
      coerceRunUsage({
        requests: 1,
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        toolCalls: 6,
      }),
    ).toEqual({
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      toolCalls: 6,
    });

    expect(
      coerceRunUsage(() => ({
        requests: 1,
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 4,
        cache_write_tokens: 5,
        tool_calls: 6,
      })),
    ).toEqual({
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      toolCalls: 6,
    });
  });

  it('adds usage from compatible shapes', () => {
    expect(
      addUsage(
        { requests: 1, inputTokens: 2 },
        { requests: 3, input_tokens: 4, tool_calls: 5 },
      ),
    ).toEqual({
      requests: 4,
      inputTokens: 6,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 5,
    });
  });
});

describe('UsageSnapshot', () => {
  it('records snake_case entries and exposes Python aliases', () => {
    const snapshot = new UsageSnapshot('run-1');

    snapshot.record({
      agent_id: 'main',
      agent_name: 'Main',
      model_id: 'model-a',
      usage: { requests: 1, input_tokens: 2, output_tokens: 3 },
    });
    snapshot.record({
      agent_id: 'main',
      agent_name: 'Main',
      model_id: 'model-a',
      usage: { requests: 2, inputTokens: 4, toolCalls: 1 },
      source: 'tool',
    });

    expect(snapshot.run_id).toBe('run-1');
    expect(snapshot.total_usage).toEqual({
      requests: 3,
      inputTokens: 6,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 1,
    });
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({
      agentId: 'main',
      agentName: 'Main',
      modelId: 'model-a',
      source: 'model_request',
    });
    expect(snapshot.agent_usages.main.usage.requests).toBe(3);
    expect(snapshot.model_usages['model-a'].inputTokens).toBe(6);
  });
});
